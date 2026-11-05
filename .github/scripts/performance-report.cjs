const fs = require('node:fs')
const path = require('node:path')

const COMMENT_MARKER = '<!-- performance-report -->'
const WARN_PERCENT = 2
const FAIL_PERCENT = 5
const GATE_MIN_MS = 10
const MAX_NOISE_PERCENT = 10
// Setup and no-match paths are dominated by index construction and search miss cost.
const INFORMATIONAL = /(?:^|\/)(?:first-content|missing)$/u
const NAME = /^[a-z0-9][a-z0-9/_-]*$/u
const SHA = /^[0-9a-f]{40}$/u

function fail(message) {
  throw new Error(message)
}

function finite(value, label, minimum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)
    fail(`${label} must be a finite number >= ${minimum}`)
}

const count = (value) => value.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',')

function validateReport(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  for (const key of ['runtime', 'os', 'cpu'])
    if (typeof value[key] !== 'string' || !value[key]) fail(`${label}.${key} must be a string`)
  if (!Array.isArray(value.results) || value.results.length === 0)
    fail(`${label}.results must be a non-empty array`)
  const names = new Set()
  for (const [index, result] of value.results.entries()) {
    if (result === null || typeof result !== 'object' || Array.isArray(result))
      fail(`${label}.results[${index}] must be an object`)
    if (typeof result.name !== 'string' || !NAME.test(result.name))
      fail(`${label}.results[${index}].name is invalid`)
    if (names.has(result.name)) fail(`${label} has duplicate metric ${result.name}`)
    names.add(result.name)
    if (!Number.isSafeInteger(result.samples) || result.samples < 1 || result.samples > 1000)
      fail(`${label}.${result.name}.samples is invalid`)
    finite(result.medianMs, `${label}.${result.name}.medianMs`, Number.EPSILON)
    if (result.worstMedianMs !== undefined)
      finite(result.worstMedianMs, `${label}.${result.name}.worstMedianMs`, Number.EPSILON)
    finite(result.p95Ms, `${label}.${result.name}.p95Ms`, Number.EPSILON)
    finite(result.maxTimerGapMs, `${label}.${result.name}.maxTimerGapMs`, 0)
    if (result.noisePercent !== undefined)
      finite(result.noisePercent, `${label}.${result.name}.noisePercent`, 0)
  }
  return value
}

function validateMeta(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  if (value.kind !== 'pull_request' && value.kind !== 'push')
    fail(`${label}.kind must be pull_request or push`)
  if (typeof value.headSha !== 'string' || !SHA.test(value.headSha))
    fail(`${label}.headSha must be a commit SHA`)
  if (value.baseSha !== null && (typeof value.baseSha !== 'string' || !SHA.test(value.baseSha)))
    fail(`${label}.baseSha must be a commit SHA or null`)
  if (value.floor === null || typeof value.floor !== 'object' || Array.isArray(value.floor))
    fail(`${label}.floor must be an object`)
  for (const [name, sha] of Object.entries(value.floor)) {
    if (!NAME.test(name)) fail(`${label}.floor has an invalid metric name`)
    if (typeof sha !== 'string' || !SHA.test(sha))
      fail(`${label}.floor.${name} must be a commit SHA`)
  }
  return value
}

function load(file) {
  return validateReport(JSON.parse(fs.readFileSync(file, 'utf8')), file)
}

function percent(base, value) {
  return (value / base - 1) * 100
}

// A ceiling is only trusted for workloads that are slow enough and stable enough to gate.
function isGated(name, result) {
  return (
    result.medianMs >= GATE_MIN_MS &&
    !INFORMATIONAL.test(name) &&
    (result.noisePercent ?? 0) <= MAX_NOISE_PERCENT
  )
}

function assess(name, before, after) {
  const change = percent(before.medianMs, after.medianMs)
  const status =
    !isGated(name, before) || !isGated(name, after)
      ? 'info'
      : change <= WARN_PERCENT
        ? 'ok'
        : after.medianMs <= (before.worstMedianMs ?? before.medianMs)
          ? 'info'
          : change > FAIL_PERCENT
            ? 'fail'
            : 'warn'
  return { change, status }
}

// Every workload is compared with its recorded ceiling. Workloads without one fall back to main.
function referenceFor({ floor, variants, base, baseSha }) {
  const reference = new Map()
  for (const [name, sha] of Object.entries(floor)) {
    const result = variants.get(sha)?.results.find((entry) => entry.name === name)
    if (result) reference.set(name, { result, sha })
  }
  for (const result of base?.results ?? [])
    if (!reference.has(result.name))
      reference.set(result.name, { result, sha: baseSha, recorded: false })
  return reference
}

function compare({ reference, current, base = null }) {
  const currentByName = new Map(current.results.map((result) => [result.name, result]))
  const baseByName = new Map((base?.results ?? []).map((result) => [result.name, result]))
  const names = [
    ...new Set([...reference.keys(), ...baseByName.keys(), ...currentByName.keys()]),
  ].sort()
  const rows = []
  for (const name of names) {
    const ceiling = reference.get(name) ?? null
    const after = currentByName.get(name) ?? null
    const main = baseByName.get(name) ?? null
    const baseChange = main && after ? percent(main.medianMs, after.medianMs) : null
    if (!after) {
      rows.push({
        name,
        ceilingMs: ceiling?.result.medianMs ?? null,
        ceilingSha: ceiling?.sha ?? null,
        baseMs: main?.medianMs ?? null,
        afterMs: null,
        change: null,
        baseChange: null,
        recorded: ceiling?.recorded !== false,
        gated: false,
        status: 'missing',
      })
    } else if (!ceiling) {
      rows.push({
        name,
        ceilingMs: null,
        ceilingSha: null,
        baseMs: main?.medianMs ?? null,
        afterMs: after.medianMs,
        change: null,
        baseChange,
        recorded: false,
        gated: false,
        status: 'new',
      })
    } else {
      const { change, status } = assess(name, ceiling.result, after)
      rows.push({
        name,
        ceilingMs: ceiling.result.medianMs,
        ceilingSha: ceiling.sha,
        baseMs: main?.medianMs ?? null,
        afterMs: after.medianMs,
        change,
        baseChange,
        recorded: ceiling.recorded !== false,
        gated: isGated(name, ceiling.result) && isGated(name, after),
        status,
      })
    }
  }
  return {
    rows,
    failed: rows.some((row) => row.status === 'fail' || row.status === 'missing'),
  }
}

function milliseconds(value) {
  if (value === null) return 'n/a'
  if (value < 10) return `${value.toFixed(2)} ms`
  if (value < 100) return `${value.toFixed(1)} ms`
  return `${count(Math.round(value))} ms`
}

function signed(value) {
  if (value === null) return 'n/a'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

const icons = { ok: '✅', warn: '⚠️', fail: '❌', missing: '❌', new: 'new', info: '·' }

function markdown({ rows, failed }) {
  const regressions = rows.filter((row) => row.status === 'fail').length
  const warnings = rows.filter((row) => row.status === 'warn').length
  const missing = rows.filter((row) => row.status === 'missing').length
  const failures = []
  if (regressions)
    failures.push(
      `${regressions} workload${regressions === 1 ? ' is' : 's are'} more than ${FAIL_PERCENT}% above the ceiling`
    )
  if (missing)
    failures.push(
      `${missing} ceiling metric${missing === 1 ? ' is' : 's are'} missing from this PR`
    )
  const summary = failed
    ? `❌ ${failures.join(', and ')}.`
    : warnings
      ? `⚠️ All gated workloads are within the ${FAIL_PERCENT}% ceiling, but ${warnings} ${warnings === 1 ? 'is' : 'are'} more than ${WARN_PERCENT}% above it.`
      : `✅ All gated workloads are within ${WARN_PERCENT}% of the ceiling.`
  const table = rows.map(
    (row) =>
      `| \`${row.name}\` | ${milliseconds(row.ceilingMs)} | ${milliseconds(row.afterMs)} | ${signed(row.change)} | ${signed(row.baseChange)} | ${icons[row.status]} |`
  )
  const ceilings = new Map()
  let unrecorded = 0
  for (const row of rows) {
    if (!row.ceilingSha) continue
    if (row.recorded) ceilings.set(row.ceilingSha, (ceilings.get(row.ceilingSha) ?? 0) + 1)
    else if (row.gated) unrecorded += 1
  }
  const shortSha = (value) => value.slice(0, 7)
  const ceilingParts = []
  if (ceilings.size)
    ceilingParts.push(
      `Ceilings: ${[...ceilings]
        .map(([sha, total]) => `\`${shortSha(sha)}\` (${total})`)
        .join(', ')}.`
    )
  if (unrecorded)
    ceilingParts.push(
      `${unrecorded} workload${unrecorded === 1 ? ' has' : 's have'} no ceiling yet and ${unrecorded === 1 ? 'is' : 'are'} compared with main.`
    )
  const ceilingLine = ceilingParts.length
    ? ceilingParts.join(' ')
    : 'No ceilings are recorded yet, so this PR is compared with main.'
  const missingLine = missing
    ? `\n\nA ceiling metric that this PR no longer measures fails the audit. If the workload was removed on purpose, delete its entry from the \`performance-floor\` branch.`
    : ''
  return `${COMMENT_MARKER}
### Performance audit

${summary}

| Workload | Ceiling | This PR | vs ceiling | vs main | Status |
| :------- | ------: | ------: | ---------: | ------: | :----: |
${table.join('\n')}

${ceilingLine} The ceiling is the best merged measurement of each workload, re-measured on this runner in the same session, so it never moves up. Slowdowns over ${WARN_PERCENT}% warn, and over ${FAIL_PERCENT}% fail only when the PR's best run is slower than the ceiling's worst run. Workloads under ${GATE_MIN_MS} ms, setup-dominated first-content, no-match search, or results with more than ${MAX_NOISE_PERCENT}% run-to-run spread are reported but not gated. "vs main" is this PR against its base. Native vault timings are not part of this report.${missingLine}
`
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!key.startsWith('--')) fail(`Unknown argument ${key}`)
    args[key.slice(2)] = argv[index + 1]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dir) fail('--dir is required')
  const meta = validateMeta(
    JSON.parse(fs.readFileSync(path.join(args.dir, 'meta.json'), 'utf8')),
    'meta.json'
  )
  const variants = new Map()
  const variant = (sha) => {
    if (!variants.has(sha)) variants.set(sha, load(path.join(args.dir, `${sha}.json`)))
    return variants.get(sha)
  }
  const current = variant(meta.headSha)
  if (meta.kind === 'pull_request' && !meta.baseSha) fail('meta.json is missing baseSha')
  const base = meta.baseSha ? variant(meta.baseSha) : null
  for (const sha of new Set(Object.values(meta.floor))) variant(sha)
  const reference = referenceFor({
    floor: meta.floor,
    variants,
    base,
    baseSha: meta.baseSha,
  })
  const compared = compare({ reference, current, base })
  const comment = markdown({ rows: compared.rows, failed: compared.failed })
  fs.writeFileSync(args.out, `${comment}\n`)
  fs.writeFileSync(args.result, `${compared.failed ? 'fail' : 'pass'}\n`)
  console.log(comment)
}

module.exports = {
  COMMENT_MARKER,
  FAIL_PERCENT,
  GATE_MIN_MS,
  INFORMATIONAL,
  MAX_NOISE_PERCENT,
  NAME,
  SHA,
  WARN_PERCENT,
  assess,
  compare,
  isGated,
  markdown,
  referenceFor,
  validateMeta,
  validateReport,
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
