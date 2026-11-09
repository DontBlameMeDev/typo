// Cold-start measurement for a release build on an Android device or emulator.
//
// The probe build logs one `[startup]` line with its own marks when the
// library's first frame is painted. This script launches the app from a dead
// process, reads that line and the process start event from logcat, and reports
// the wall time a user waits: process start, native splash, bundle load, fonts,
// and the first library frame.
//
// Usage:
//   EXPO_PUBLIC_TYPO_STARTUP=1 bun run build:web && bunx expo prebuild -p android
//   cd android && ./gradlew assembleRelease -PreactNativeArchitectures=x86_64
//   bun scripts/startup-seed.ts
//   bun scripts/startup.ts --apk android/app/build/outputs/apk/release/app-release.apk
//
// Both ends come from the device clock, so adb latency cannot skew the result.
// A WebView sandbox process also names the app in its arguments, so the process
// start event is matched on its package field.

import { AdbError, adb, tryAdb, wait, waitForBoot } from './android'

const args = new Map<string, string>()
for (let index = 0; index < process.argv.length; index++) {
  const value = process.argv[index]
  if (!value.startsWith('--')) continue
  const next = process.argv[index + 1]
  args.set(value.slice(2), next && !next.startsWith('--') ? next : 'true')
}

const APK = args.get('apk')
const RUNS = Number(args.get('runs') ?? 5)
const PACKAGE = args.get('package') ?? 'org.dontblameme.typo'
const ACTIVITY = args.get('activity') ?? '.MainActivity'
const JSON_OUT = args.get('json')
const LAUNCH_TIMEOUT = 120_000
const MARK = '[startup]'

export type Sample = {
  coldStartMs: number
  phases: Record<string, number>
}

export type StartupReport = {
  package: string
  runs: number
  // The fastest launch is the cleanest one: contention only adds time, so the
  // best sample is the most stable measure across runner instances.
  bestMs: number
  medianMs: number
  phases: Record<string, number>
  samples: number[]
}

const EPOCH = /^\s*(\d+\.\d+)\s+\d+\s+\d+\s/u

/** Device wall-clock milliseconds at the start of a logcat line. */
export function logcatTime(line: string): number | null {
  const match = EPOCH.exec(line)
  return match ? Math.round(Number(match[1]) * 1000) : null
}

/**
 * The process start event for exactly one package, not for a child process.
 * The fields are [userId, pid, uid, package, type, ...], and a WebView sandbox
 * process carries the app name further along, so match the package field only.
 */
export function isProcessStart(line: string, packageName: string): boolean {
  const marker = 'am_proc_start: ['
  const start = line.indexOf(marker)
  if (start === -1) return false
  return line.slice(start + marker.length).split(',')[3] === packageName
}

/** The JSON object after the probe marker, or null when the line has none. */
export function parseMarks(line: string): Record<string, number> | null {
  const index = line.indexOf(MARK)
  if (index === -1) return null
  try {
    const value: unknown = JSON.parse(line.slice(index + MARK.length))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const marks: Record<string, number> = {}
    for (const [name, mark] of Object.entries(value))
      if (typeof mark === 'number' && Number.isFinite(mark)) marks[name] = mark
    return marks
  } catch {
    return null
  }
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error('cannot take the median of no samples')
  const sorted = [...values].sort((a, b) => a - b)
  const value = sorted[Math.floor(sorted.length / 2)]
  if (value === undefined) throw new Error('cannot take the median of no samples')
  return value
}

export function summarize(packageName: string, samples: Sample[]): StartupReport {
  if (samples.length === 0) throw new Error('no samples were taken')
  const names = [...new Set(samples.flatMap((sample) => Object.keys(sample.phases)))].sort()
  const phases: Record<string, number> = {}
  for (const name of names) {
    const values = samples
      .map((sample) => sample.phases[name])
      .filter((value): value is number => value !== undefined)
    if (values.length > 0) phases[name] = median(values)
  }
  const cold = samples.map((sample) => sample.coldStartMs)
  return {
    package: packageName,
    runs: samples.length,
    bestMs: Math.min(...cold),
    medianMs: median(cold),
    phases,
    samples: cold,
  }
}

function serialArgs() {
  return process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : []
}

if (import.meta.main) {
  await waitForBoot()
  if (APK) await adb('install', '-r', APK)

  async function sample(): Promise<Sample> {
    await adb('shell', 'am', 'force-stop', PACKAGE)
    // A force-stop is asynchronous. Launching while the old process is still
    // alive measures a warm start.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await tryAdb('shell', 'pidof', PACKAGE)).stdout.trim()) break
      await wait(100)
    }
    // Clearing only main and system leaves old events, and a stale
    // am_proc_start makes every cold start look minutes long.
    await adb('logcat', '-b', 'all', '-c')

    const lines: string[] = []
    let sawReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      sawReady = resolve
    })
    const logcat = Bun.spawn(
      [process.env.ADB ?? 'adb', ...serialArgs(), 'logcat', '-b', 'events,main', '-v', 'epoch'],
      {
        stdout: 'pipe',
        stderr: 'ignore',
      }
    )
    const reader = (async () => {
      const decoder = new TextDecoder()
      let pending = ''
      for await (const chunk of logcat.stdout as ReadableStream<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true })
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        for (const text of parts) {
          if (logcatTime(text) === null) continue
          lines.push(text)
          if (text.includes(MARK)) sawReady()
        }
      }
    })()

    const launch = Bun.spawn(
      [
        process.env.ADB ?? 'adb',
        ...serialArgs(),
        'shell',
        'am',
        'start',
        '-W',
        '-S',
        '-n',
        `${PACKAGE}/${ACTIVITY}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    await new Response(launch.stdout).text()
    await launch.exited
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      sawReady()
    }, LAUNCH_TIMEOUT)
    await ready
    clearTimeout(timeout)
    logcat.kill()
    await reader

    if (timedOut)
      throw new AdbError(
        `the app logged no ${MARK} line within ${LAUNCH_TIMEOUT} ms\n${lines.slice(-20).join('\n')}`
      )
    const finished = lines.find((line) => line.includes(MARK))
    const finishedAt = finished ? logcatTime(finished) : null
    const phases = finished ? parseMarks(finished) : null
    if (finishedAt === null || !phases) throw new AdbError(`cannot parse the ${MARK} line`)
    const started = lines.findLast(
      (line) => isProcessStart(line, PACKAGE) && (logcatTime(line) ?? Infinity) <= finishedAt
    )
    const startedAt = started ? logcatTime(started) : null
    if (startedAt === null) throw new AdbError('logcat has no am_proc_start event for the app')
    return { coldStartMs: finishedAt - startedAt, phases }
  }

  const samples: Sample[] = []
  for (let run = 0; run < RUNS; run++) {
    const result = await sample()
    samples.push(result)
    console.info(
      `run ${run + 1}/${RUNS}: ${result.coldStartMs} ms cold, ` +
        Object.entries(result.phases)
          .map(([name, value]) => `${name} ${value}`)
          .join(', ')
    )
  }

  const report = summarize(PACKAGE, samples)
  console.info(`${PACKAGE} cold start: ${report.bestMs} ms best, ${report.medianMs} ms median`)
  if (JSON_OUT) {
    await Bun.write(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`)
    console.info(`startup: wrote ${JSON_OUT}`)
  } else console.info(JSON.stringify(report))
}
