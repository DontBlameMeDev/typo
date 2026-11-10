const fs = require('node:fs')
const path = require('node:path')

const COMMENT_MARKER = '<!-- performance-report -->'
// Timing method. Measurements taken another way are not comparable, so their
// ceilings are ignored until a run on the current method records them again.
const METHOD = 2
const NAME = /^[a-z0-9][a-z0-9/_-]*$/u
const SHA = /^[0-9a-f]{40}$/u

function fail(message) {
  throw new Error(message)
}

function finite(value, label, minimum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)
    fail(`${label} must be a finite number >= ${minimum}`)
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail(`${label} must be an integer between ${minimum} and ${maximum}`)
}

const count = (value) => value.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',')

function validateReport(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  for (const key of ['runtime', 'os', 'cpu'])
    if (typeof value[key] !== 'string' || !value[key]) fail(`${label}.${key} must be a string`)
  if (value.method !== undefined) integer(value.method, `${label}.method`, 1, 1000)
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
    // Commits measured before the criterion was declared still validate.
    if (
      result.criterion !== undefined &&
      (typeof result.criterion !== 'string' || !result.criterion)
    )
      fail(`${label}.${result.name}.criterion must be a non-empty string`)
    if (result.budgetMs !== undefined)
      finite(result.budgetMs, `${label}.${result.name}.budgetMs`, Number.EPSILON)
    integer(result.samples, `${label}.${result.name}.samples`, 1, 1000)
    if (result.repeat !== undefined)
      integer(result.repeat, `${label}.${result.name}.repeat`, 1, 100000)
    finite(result.medianMs, `${label}.${result.name}.medianMs`, Number.EPSILON)
    if (result.worstMedianMs !== undefined)
      finite(result.worstMedianMs, `${label}.${result.name}.worstMedianMs`, Number.EPSILON)
    finite(result.p95Ms, `${label}.${result.name}.p95Ms`, Number.EPSILON)
    if (result.worstP95Ms !== undefined)
      finite(result.worstP95Ms, `${label}.${result.name}.worstP95Ms`, Number.EPSILON)
    finite(result.maxTimerGapMs, `${label}.${result.name}.maxTimerGapMs`, 0)
    if (result.worstTimerGapMs !== undefined)
      finite(result.worstTimerGapMs, `${label}.${result.name}.worstTimerGapMs`, 0)
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
  if (value.budgets !== undefined) {
    if (value.budgets === null || typeof value.budgets !== 'object' || Array.isArray(value.budgets))
      fail(`${label}.budgets must be an object`)
    for (const [name, budget] of Object.entries(value.budgets)) {
      if (!NAME.test(name)) fail(`${label}.budgets has an invalid metric name`)
      finite(budget, `${label}.budgets.${name}`, Number.EPSILON)
    }
  }
  return value
}

function load(file) {
  return validateReport(JSON.parse(fs.readFileSync(file, 'utf8')), file)
}

function percent(base, value) {
  return (value / base - 1) * 100
}

// The ceiling is re-measured in the same session as the pull request, but the
// two blocks still drift. A workload is reported only when it leaves the
// ceiling's worst run by more than 5%, or by the spread either side showed
// between its own rounds, whichever is larger. A metric that cannot resolve 5%
// cannot be gated at 5%.
const FAIL_MARGIN = 0.05

// Both thresholds are measured from the ceiling's worst run, so a PR has to
// leave the ceiling's observed range before it is reported. Comparing with the
// ceiling's best run instead would warn on about half of all unchanged
// workloads, because both sides are a minimum of three noisy rounds.
function regression(label, value, best, worst, ownBest = value, ownWorst = value) {
  const bound = worst ?? best
  const ceilingSpan = worst === undefined ? 0 : worst - best
  const ownSpan = ownWorst - ownBest
  const margin = Math.max(bound * FAIL_MARGIN, ceilingSpan, ownSpan)
  if (value > bound + margin)
    return {
      kind: 'ceiling',
      status: 'fail',
      note: `${label} ${precise(value)} > ceiling's worst ${precise(bound)} by more than ${precise(margin)}`,
    }
  if (value > bound + margin / 2)
    return {
      kind: 'ceiling',
      status: 'warn',
      note: `${label} ${precise(value)} > ceiling's worst ${precise(bound)}`,
    }
  return null
}

function assess({ after, reference, budget }) {
  const findings = []
  if (typeof after.criterion !== 'string' || !after.criterion)
    findings.push({ kind: 'criterion', status: 'fail', note: 'no criterion declared' })
  if (!(budget > 0)) findings.push({ kind: 'budget', status: 'fail', note: 'no budget declared' })
  else if (after.medianMs > budget * (1 + FAIL_MARGIN)) {
    // A runner that is slow for the PR is slow for the re-measured ceiling too, so
    // an over-budget ceiling means the budget cannot be judged on this runner.
    const judgeable = reference ? reference.medianMs <= budget : false
    findings.push({
      kind: 'budget',
      status: judgeable ? 'fail' : 'warn',
      note: judgeable
        ? `median ${precise(after.medianMs)} > budget ${precise(budget)}`
        : `median ${precise(after.medianMs)} > budget ${precise(budget)}, and so is the ceiling on this runner`,
    })
  }
  if (reference)
    findings.push(
      ...[
        regression(
          'median',
          after.medianMs,
          reference.medianMs,
          reference.worstMedianMs,
          after.medianMs,
          after.worstMedianMs
        ),
        regression(
          'p95',
          after.p95Ms,
          reference.p95Ms,
          reference.worstP95Ms,
          after.p95Ms,
          after.worstP95Ms
        ),
        regression(
          'p99 operation',
          after.maxTimerGapMs,
          reference.maxTimerGapMs,
          reference.worstTimerGapMs,
          after.maxTimerGapMs,
          after.worstTimerGapMs
        ),
      ].filter(Boolean)
    )
  const status = findings.some((finding) => finding.status === 'fail')
    ? 'fail'
    : findings.length > 0
      ? 'warn'
      : 'ok'
  return { status, findings }
}

// Every workload is compared with its recorded ceiling. Workloads without one fall back to main.
function referenceFor({ floor, variants, base, baseSha, method }) {
  const reference = new Map()
  for (const [name, sha] of Object.entries(floor)) {
    const variant = variants.get(sha)
    if (!variant || variant.method !== method) continue
    const result = variant.results.find((entry) => entry.name === name)
    if (result) reference.set(name, { result, sha, recorded: true, comparable: true })
  }
  for (const result of base?.results ?? [])
    if (!reference.has(result.name))
      reference.set(result.name, {
        result,
        sha: baseSha,
        recorded: false,
        comparable: base.method !== undefined && base.method === method,
      })
  return reference
}

function compare({ reference, current, base = null, budgets = {} }) {
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
    // The trusted budget is the ceiling branch's record. A ceiling measurement from
    // merged code also carries the budget that code declared.
    const trusted = budgets[name] ?? (ceiling?.recorded ? (ceiling.result.budgetMs ?? null) : null)
    const declared = after?.budgetMs ?? null
    // A budget may only tighten.
    const budget = trusted === null ? declared : Math.min(trusted, declared ?? trusted)
    const baseChange = main && after ? percent(main.medianMs, after.medianMs) : null
    const row = {
      name,
      criterion: after?.criterion ?? '',
      budgetMs: budget,
      ceilingMs: ceiling?.result.medianMs ?? null,
      ceilingWorstMs: ceiling?.result.worstMedianMs ?? null,
      ceilingSha: ceiling?.sha ?? null,
      baseMs: main?.medianMs ?? null,
      afterMs: after?.medianMs ?? null,
      afterP95Ms: after?.p95Ms ?? null,
      afterWorstMs: after?.maxTimerGapMs ?? null,
      noisePercent: after?.noisePercent ?? null,
      change: ceiling && after ? percent(ceiling.result.medianMs, after.medianMs) : null,
      baseChange,
      recorded: ceiling ? ceiling.recorded !== false : false,
      comparable: ceiling?.comparable ?? false,
      status: 'ok',
      findings: [],
    }
    if (!after) {
      row.status = 'missing'
      row.findings = [{ kind: 'missing', status: 'fail', note: 'not measured in this PR' }]
    } else {
      row.findings = assess({
        after,
        reference: ceiling?.comparable ? ceiling.result : null,
        budget,
      }).findings
      if (trusted !== null && declared !== null && declared > trusted)
        row.findings.unshift({
          kind: 'loosened',
          status: 'fail',
          note: `budget raised from ${milliseconds(trusted)} to ${milliseconds(declared)}`,
        })
      const failed = row.findings.some((finding) => finding.status === 'fail')
      const warned = row.findings.some((finding) => finding.status === 'warn')
      row.status = failed ? 'fail' : warned ? 'warn' : ceiling?.comparable ? 'ok' : 'new'
      if (!ceiling?.comparable && !failed && !warned)
        row.findings.push({
          kind: 'new',
          status: 'ok',
          note: ceiling ? 'no comparable ceiling' : 'no ceiling yet',
        })
    }
    rows.push(row)
  }
  return {
    rows,
    failed: rows.some((row) => row.status === 'fail' || row.status === 'missing'),
  }
}

function milliseconds(value) {
  if (value === null || value === undefined) return 'n/a'
  if (value < 10) return `${value.toFixed(2)} ms`
  if (value < 100) return `${value.toFixed(1)} ms`
  return `${count(Math.round(value))} ms`
}

// Notes compare two values, so they must never round to the same number.
function precise(value) {
  if (value === null || value === undefined) return 'n/a'
  if (value < 10) return `${value.toFixed(3)} ms`
  return `${value.toFixed(1)} ms`
}

function signed(value) {
  if (value === null || value === undefined) return 'n/a'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

const icons = { ok: '✅', warn: '⚠️', fail: '❌', missing: '❌', new: '🆕' }

// The criterion comes from the measured commit, so it must not break the table.
function criterionText(value) {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/\|/gu, '\\|')
    .replace(/[\r\n]+/gu, ' ')
}

const plural = (total, one, many) => (total === 1 ? one : many)

function markdown({ rows, failed, methodChanged = false }) {
  const failing = (kind) =>
    rows.filter(
      (row) =>
        row.status === 'fail' &&
        row.findings.some((finding) => finding.kind === kind && finding.status === 'fail')
    ).length
  const missing = rows.filter((row) => row.status === 'missing').length
  const warnings = rows.filter((row) => row.status === 'warn').length
  const measured = rows.filter((row) => row.afterMs !== null).length
  const parts = []
  const regressions = failing('ceiling')
  const budgets = failing('budget')
  const criteria = failing('criterion')
  const loosened = failing('loosened')
  if (regressions)
    parts.push(
      `${regressions} ${plural(regressions, 'workload is', 'workloads are')} slower than the ceiling`
    )
  if (budgets)
    parts.push(`${budgets} ${plural(budgets, 'workload is', 'workloads are')} over budget`)
  if (loosened)
    parts.push(`${loosened} ${plural(loosened, 'workload raised', 'workloads raised')} a budget`)
  if (criteria)
    parts.push(
      `${criteria} ${plural(criteria, 'workload declares', 'workloads declare')} no criterion`
    )
  if (missing) parts.push(`${missing} ${plural(missing, 'workload is', 'workloads are')} missing`)
  const summary = failed
    ? `❌ ${parts.join(', and ')}.`
    : warnings
      ? `⚠️ No workload failed, but ${warnings} of ${measured} ${plural(warnings, 'has', 'have')} a warning above the ceiling's worst run or over a budget the ceiling misses too.`
      : `✅ All ${measured} ${plural(measured, 'workload is', 'workloads are')} within budget and at or below the ceiling.`
  const table = rows.map((row) => {
    const status = row.findings.length
      ? `${icons[row.status]} ${row.findings.map((finding) => finding.note).join('; ')}`
      : icons[row.status]
    const budget = row.budgetMs
    const criterion = row.criterion ? `<br><sub>${criterionText(row.criterion)}</sub>` : ''
    const noise = row.noisePercent === null ? '' : ` <sub>±${row.noisePercent.toFixed(0)}%</sub>`
    const tail =
      row.afterP95Ms === null
        ? 'n/a'
        : `${milliseconds(row.afterP95Ms)} / ${milliseconds(row.afterWorstMs)}`
    // The gate uses the ceiling's worst run, so show it next to its best.
    const ceiling =
      row.ceilingWorstMs === null ||
      milliseconds(row.ceilingWorstMs) === milliseconds(row.ceilingMs)
        ? milliseconds(row.ceilingMs)
        : `${milliseconds(row.ceilingMs)} <sub>(worst ${milliseconds(row.ceilingWorstMs)})</sub>`
    return `| \`${row.name}\`${criterion} | ${milliseconds(budget)} | ${ceiling} | ${milliseconds(row.afterMs)}${noise} | ${tail} | ${signed(row.change)} | ${signed(row.baseChange)} | ${status} |`
  })
  const ceilings = new Map()
  let unrecorded = 0
  for (const row of rows) {
    if (!row.ceilingSha) continue
    if (row.recorded) ceilings.set(row.ceilingSha, (ceilings.get(row.ceilingSha) ?? 0) + 1)
    else unrecorded += 1
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
      `${unrecorded} ${plural(unrecorded, 'workload has', 'workloads have')} no ceiling yet and ${plural(unrecorded, 'is', 'are')} compared with main.`
    )
  const ceilingLine = ceilingParts.length
    ? ceilingParts.join(' ')
    : 'No ceilings are recorded yet, so this PR is compared with main.'
  const missingLine = rows.some((row) => row.status === 'missing' && row.recorded)
    ? `\n\nA workload that this PR no longer measures fails the audit. If the workload was removed on purpose, delete its entry from \`performance-floor.json\` on the \`floors\` branch.`
    : ''
  const methodLine = methodChanged
    ? `\n\nThis PR changes how workloads are timed, so the current ceilings and main are not comparable with it. Budgets still apply. The next push to main records a ceiling on the new method.`
    : ''
  return `${COMMENT_MARKER}
### Performance audit

${summary}

| Workload | Budget | Ceiling | This PR | Tail (p95 / p99) | vs ceiling | vs main | Status |
| :------- | -----: | ------: | ------: | -------------------: | ---------: | ------: | :----- |
${table.join('\n')}

${ceilingLine}

Every workload has a criterion and a budget: the time it may take on this runner, at the median and for every single operation. A workload fails when its best of three runs is more than ${(FAIL_MARGIN * 100).toFixed(0)}% slower than the ceiling's worst run at the median, the p95, or the p99 operation, or by more than either side's spread between rounds, whichever is larger. It warns at half that margin. It also fails when it is over budget while the ceiling is not. Budgets can only be tightened. Ceilings are the best merged measurement of each workload, re-measured on this runner in the same session, so runner speed cancels out. Native vault timings are not part of this report.${methodLine}${missingLine}
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
    method: current.method,
  })
  const compared = compare({ reference, current, base, budgets: meta.budgets ?? {} })
  const methodChanged = Boolean(base) && base.method !== current.method
  const comment = markdown({ rows: compared.rows, failed: compared.failed, methodChanged })
  fs.writeFileSync(args.out, `${comment}\n`)
  fs.writeFileSync(args.result, `${compared.failed ? 'fail' : 'pass'}\n`)
  console.log(comment)
}

module.exports = {
  COMMENT_MARKER,
  METHOD,
  NAME,
  SHA,
  assess,
  compare,
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
