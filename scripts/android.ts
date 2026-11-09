// adb helpers for the startup workflows. They drive one device, selected with
// ANDROID_SERIAL or ADB when several emulators are running.

export const ADB = process.env.ADB ?? 'adb'
export const SERIAL = process.env.ANDROID_SERIAL ?? ''
const ADB_ARGS = SERIAL ? ['-s', SERIAL] : []

export class AdbError extends Error {}

/** Runs an adb command and returns stdout. Throws on a non-zero exit code. */
export async function adb(...command: string[]): Promise<string> {
  const result = await Bun.$`${ADB} ${ADB_ARGS} ${command}`.quiet().nothrow()
  if (result.exitCode !== 0)
    throw new AdbError(`adb ${command.join(' ')} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

/** Runs an adb command and returns its exit code and stdout. */
export async function tryAdb(...command: string[]) {
  const result = await Bun.$`${ADB} ${ADB_ARGS} ${command}`.quiet().nothrow()
  return { exitCode: result.exitCode, stdout: result.stdout.toString() }
}

export function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForBoot(timeout = 180_000) {
  await adb('wait-for-device')
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await tryAdb('shell', 'getprop', 'sys.boot_completed')).stdout.trim() === '1') return
    await wait(1000)
  }
  throw new AdbError('the device did not finish booting')
}

type UiNode = { text: string; label: string; bounds: [number, number, number, number] }

const BOUNDS = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/u
const UI_DUMP = '/sdcard/typo-ui.xml'

/**
 * Reads the accessibility tree of the current screen. `uiautomator dump` fails
 * quietly now and then, so the old file is removed first and a missing one
 * yields no nodes: callers retry on their next poll instead of reading the
 * previous screen or failing the run.
 */
export async function screenNodes(): Promise<UiNode[]> {
  // A stale dump would hand out the previous screen's coordinates, so stop
  // unless the old file is gone and the new dump succeeded.
  if ((await tryAdb('shell', 'rm', '-f', UI_DUMP)).exitCode !== 0) return []
  if ((await tryAdb('shell', 'uiautomator', 'dump', UI_DUMP)).exitCode !== 0) return []
  const dump = await tryAdb('shell', 'cat', UI_DUMP)
  if (dump.exitCode !== 0) return []
  const xml = dump.stdout
  const nodes: UiNode[] = []
  for (const tag of xml.match(/<node\b[^>]*>/gu) ?? []) {
    const bounds = BOUNDS.exec(tag)
    if (!bounds) continue
    const text = /\btext="([^"]*)"/u.exec(tag)?.[1] ?? ''
    const label = /\bcontent-desc="([^"]*)"/u.exec(tag)?.[1] ?? ''
    if (!text && !label) continue
    nodes.push({
      text: decode(text),
      label: decode(label),
      bounds: [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])],
    })
  }
  return nodes
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#10': '\n',
}

// One pass only, so an escaped entity such as `&amp;lt;` stays text instead of
// being unescaped twice.
function decode(value: string) {
  return value.replace(/&(amp|lt|gt|quot|apos|#10);/gu, (entity, name: string) =>
    name in ENTITIES ? ENTITIES[name] : entity
  )
}

function matches(node: UiNode, text: string) {
  return node.text === text || node.label === text
}

const NOT_RESPONDING = /(?:isn't|is not) responding/iu

/**
 * A freshly booted emulator can show an ANR dialog over the app. Tapping "Wait"
 * keeps the flow going instead of waiting out the tap timeout on a covered
 * screen.
 */
async function dismissAnr(nodes: UiNode[]) {
  if (!nodes.some((node) => NOT_RESPONDING.test(node.text) || NOT_RESPONDING.test(node.label)))
    return false
  const wait =
    nodes.find((node) => matches(node, 'Wait')) ?? nodes.find((node) => matches(node, 'Close app'))
  if (!wait) return false
  const [left, top, right, bottom] = wait.bounds
  await adb(
    'shell',
    'input',
    'tap',
    `${Math.round((left + right) / 2)}`,
    `${Math.round((top + bottom) / 2)}`
  )
  return true
}

/**
 * Waits for a node whose text or accessibility label matches, then taps its
 * center. Matching prefers an exact text or label, then a case-insensitive
 * one, then a substring, so a screen with both "Documents" and "Documents
 * usage" still hits the right control.
 */
export async function tapText(text: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const nodes = await screenNodes()
    if (await dismissAnr(nodes)) {
      await wait(1000)
      continue
    }
    const node =
      nodes.find((candidate) => matches(candidate, text)) ??
      nodes.find((candidate) => matches(candidate, text.toUpperCase())) ??
      nodes.find((candidate) => matches(candidate, text.toLowerCase())) ??
      nodes.find(
        (candidate) =>
          candidate.text.toLowerCase().includes(text.toLowerCase()) ||
          candidate.label.toLowerCase().includes(text.toLowerCase())
      )
    if (node) {
      const [left, top, right, bottom] = node.bounds
      await adb(
        'shell',
        'input',
        'tap',
        `${Math.round((left + right) / 2)}`,
        `${Math.round((top + bottom) / 2)}`
      )
      return
    }
    await wait(500)
  }
  const screen = (await screenNodes())
    .slice(0, 12)
    .map((node) => node.text || node.label)
    .filter(Boolean)
    .join(' | ')
  throw new AdbError(
    `no control with text "${text}" appeared within ${timeout} ms` +
      (screen ? `\nlast screen: ${screen}` : '')
  )
}

/** Waits until the app owns the focused window. */
export async function waitForApp(packageName: string, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const focus = await tryAdb('shell', 'dumpsys', 'window')
    if (focus.stdout.includes(`mCurrentFocus=Window{`) && focus.stdout.includes(packageName)) return
    await wait(1000)
  }
  throw new AdbError(`${packageName} never came to the foreground`)
}

export async function hasText(text: string, timeout = 0) {
  const deadline = Date.now() + timeout
  while (true) {
    const nodes = await screenNodes()
    if (nodes.some((node) => matches(node, text) || node.text.includes(text))) return true
    if (Date.now() >= deadline) return false
    await wait(500)
  }
}
