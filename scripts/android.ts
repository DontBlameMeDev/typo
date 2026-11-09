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

/** Reads the accessibility tree of the current screen. */
export async function screenNodes(): Promise<UiNode[]> {
  await adb('shell', 'uiautomator', 'dump', '/sdcard/typo-ui.xml')
  const xml = await adb('shell', 'cat', '/sdcard/typo-ui.xml')
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

function decode(value: string) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#10;', '\n')
    .replaceAll('&apos;', "'")
}

function matches(node: UiNode, text: string) {
  return node.text === text || node.label === text
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
  throw new AdbError(`no control with text "${text}" appeared within ${timeout} ms`)
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
