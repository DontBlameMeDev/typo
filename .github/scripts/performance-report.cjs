const fs = require('node:fs')

const COMMENT_MARKER = '<!-- performance-report -->'
const WARN_PERCENT = 2
const FAIL_PERCENT = 5
const GATE_MIN_MS = 10
const NAME = /^[a-z0-9][a-z0-9/_-]*$/u

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
    finite(result.p95Ms, `${label}.${result.name}.p95Ms`, Number.EPSILON)
    finite(result.maxTimerGapMs, `${label}.${result.name}.maxTimerGapMs`, 0)
  }
  return value
}

function load(path) {
  return validateReport(JSON.parse(fs.readFileSync(path, 'utf8')), path)
}

function percent(base, value) {
  return (value / base - 1) * 100
}

function compare(base, current) {
  const baseline = new Map(base.results.map((result) => [result.name, result]))
  const measured = new Map(current.results.map((result) => [result.name, result]))
  const names = [...baseline.keys(), ...[...measured.keys()].filter((name) => !baseline.has(name))]
  const rows = []
  for (const name of names) {
    const before = baseline.get(name)
    const after = measured.get(name)
    if (!after) {
      rows.push({ name, before: before.medianMs, after: null, change: null, status: 'missing' })
      continue
    }
    if (!before) {
      rows.push({ name, before: null, after: after.medianMs, change: null, status: 'new' })
      continue
    }
    const change = percent(before.medianMs, after.medianMs)
    const status =
      before.medianMs < GATE_MIN_MS
        ? 'info'
        : change > FAIL_PERCENT
          ? 'fail'
          : change > WARN_PERCENT
            ? 'warn'
            : 'ok'
    rows.push({ name, before: before.medianMs, after: after.medianMs, change, status })
  }
  return { rows, failed: rows.some((row) => row.status === 'fail' || row.status === 'missing') }
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

function markdown({ baseSha, prSha, rows, failed }) {
  const regressions = rows.filter((row) => row.status === 'fail').length
  const warnings = rows.filter((row) => row.status === 'warn').length
  const missing = rows.filter((row) => row.status === 'missing').length
  const summary = failed
    ? `❌ ${regressions} workload${regressions === 1 ? '' : 's'} regressed by more than ${FAIL_PERCENT}%${missing ? `, and ${missing} baseline metric${missing === 1 ? ' is' : 's are'} missing` : ''}.`
    : warnings
      ? `⚠️ All gated workloads are within the ${FAIL_PERCENT}% hard limit, but ${warnings} slowed by more than ${WARN_PERCENT}%.`
      : `✅ All gated workloads are within the ${WARN_PERCENT}% warning limit.`
  const table = rows.map(
    (row) =>
      `| \`${row.name}\` | ${milliseconds(row.before)} | ${milliseconds(row.after)} | ${signed(row.change)} | ${icons[row.status]} |`
  )
  const shortSha = (value) =>
    /^[0-9a-f]{7,40}$/iu.test(value ?? '') ? value.slice(0, 7) : 'unknown'
  const links = [
    baseSha && `Main floor: ${shortSha(baseSha)}`,
    prSha && `This PR: ${shortSha(prSha)}`,
  ].filter(Boolean)
  return `${COMMENT_MARKER}
### Performance audit

${summary}

| Workload | Main floor | This PR | Change | Status |
| :------- | ---------: | ------: | -----: | :----: |
${table.join('\n')}

${links.join(' · ')}

Updated in place by a trusted workflow. Each side is the best of three interleaved host benchmark runs on the same runner. Slowdowns over ${WARN_PERCENT}% warn, and over ${FAIL_PERCENT}% fail. Workloads under ${GATE_MIN_MS} ms are reported but not gated. Native vault timings are not part of this report.`
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
  if (!args.base) fail('--base is required')
  const pr = load(args.pr)
  const compared = compare(load(args.base), pr)
  const comment = markdown({
    baseSha: args['base-sha'],
    prSha: args['pr-sha'],
    rows: compared.rows,
    failed: compared.failed,
  })
  const result = compared.failed ? 'fail' : 'pass'
  fs.writeFileSync(args.out, `${comment}\n`)
  fs.writeFileSync(args.result, `${result}\n`)
  console.log(comment)
}

module.exports = { COMMENT_MARKER, compare, markdown, validateReport }

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
