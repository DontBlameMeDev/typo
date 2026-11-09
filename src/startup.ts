// Cold-start timings. Every mark is milliseconds from the first line of the JS
// bundle, and one line with all of them is logged when the library paints. The
// startup workflow reads that line, so keep the mark names stable.
//
// Probe builds set EXPO_PUBLIC_TYPO_STARTUP=1. Release builds leave it unset
// and log nothing.
const startedAt = performance.now()
const enabled = process.env.EXPO_PUBLIC_TYPO_STARTUP === '1'
const marks: Record<string, number> = {}
let reported = false

export function markStartup(name: string) {
  if (!enabled) return
  marks[name] = Math.round(performance.now() - startedAt)
}

export function reportStartup() {
  if (!enabled || reported) return
  reported = true
  console.info(`[startup] ${JSON.stringify(marks)}`)
}
