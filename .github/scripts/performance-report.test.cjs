const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const report = require('./performance-report.cjs')

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

function metric(name, values) {
  const {
    medianMs,
    worstMedianMs = medianMs,
    p95Ms = medianMs * 1.5,
    worstP95Ms = worstMedianMs * 1.6,
    maxTimerGapMs = medianMs * 1.1,
    worstTimerGapMs = worstMedianMs * 1.2,
    budgetMs = 100,
    criterion = 'test criterion',
    noisePercent = 0,
  } = values
  return {
    name,
    criterion,
    budgetMs,
    samples: 15,
    repeat: 1,
    medianMs,
    worstMedianMs,
    p95Ms,
    worstP95Ms,
    maxTimerGapMs,
    worstTimerGapMs,
    noisePercent,
  }
}

function artifact(results, method = report.METHOD) {
  return { method, runtime: 'Bun 1.4.2', os: 'linux', cpu: 'test', results }
}

function reference(results, sha = SHA, recorded = true) {
  return new Map(
    results.map((result) => [result.name, { result, sha, recorded, comparable: true }])
  )
}

const statuses = (compared) => compared.rows.map((row) => [row.name, row.status])

test('a workload inside its ceiling and budget passes', () => {
  const compared = report.compare({
    reference: reference([metric('search/1000/literal', { medianMs: 4.2, worstMedianMs: 4.6 })]),
    current: artifact([metric('search/1000/literal', { medianMs: 4.1, worstMedianMs: 4.2 })]),
  })
  assert.equal(compared.failed, false)
  assert.deepEqual(statuses(compared), [['search/1000/literal', 'ok']])
  const body = report.markdown({ rows: compared.rows, failed: false })
  assert.match(body, /✅ All 1 workload is within budget/)
})

test('a slowdown inside the ceiling spread warns but does not fail', () => {
  const compared = report.compare({
    reference: reference([metric('search/1000/literal', { medianMs: 4, worstMedianMs: 4.4 })]),
    current: artifact([metric('search/1000/literal', { medianMs: 4.3 })]),
  })
  assert.equal(compared.failed, false)
  assert.deepEqual(statuses(compared), [['search/1000/literal', 'warn']])
  const body = report.markdown({ rows: compared.rows, failed: false })
  assert.match(body, /median 4\.30 ms > ceiling 4\.00 ms/)
  assert.match(body, /but 1 of 1 has a warning above the ceiling's best run/)
})

test('a slowdown beyond the ceiling spread fails at the median, p95, and p99 operation', () => {
  const compared = report.compare({
    reference: reference([
      metric('slow-median', { medianMs: 4, worstMedianMs: 4.4 }),
      metric('slow-tail', { medianMs: 4, worstMedianMs: 4.4, p95Ms: 5, worstP95Ms: 5.5 }),
      metric('slow-block', {
        medianMs: 4,
        worstMedianMs: 4.4,
        maxTimerGapMs: 6,
        worstTimerGapMs: 7,
      }),
      metric('fast', { medianMs: 4, worstMedianMs: 4.4 }),
    ]),
    current: artifact([
      metric('slow-median', { medianMs: 4.6 }),
      metric('slow-tail', { medianMs: 4.2, p95Ms: 6 }),
      metric('slow-block', { medianMs: 4.2, maxTimerGapMs: 8 }),
      metric('fast', { medianMs: 4.3 }),
    ]),
  })
  assert.equal(compared.failed, true)
  assert.deepEqual(statuses(compared), [
    ['fast', 'warn'],
    ['slow-block', 'fail'],
    ['slow-median', 'fail'],
    ['slow-tail', 'fail'],
  ])
  const body = report.markdown({ rows: compared.rows, failed: true })
  assert.match(body, /median 4\.60 ms > ceiling's worst 4\.40 ms/)
  assert.match(body, /p95 6\.00 ms > ceiling's worst 5\.50 ms/)
  assert.match(body, /p99 operation 8\.00 ms > ceiling's worst 7\.00 ms/)
  assert.match(body, /3 workloads are slower than the ceiling/)
})

test('a workload over its budget fails when the ceiling meets the budget', () => {
  const compared = report.compare({
    reference: reference([
      metric('search/1000/literal', { medianMs: 30, worstMedianMs: 33, budgetMs: 33.4 }),
      metric('search/1000/names', { medianMs: 30, worstMedianMs: 33, budgetMs: 33.4 }),
    ]),
    current: artifact([
      metric('search/1000/literal', { medianMs: 40, budgetMs: 33.4 }),
      metric('search/1000/names', { medianMs: 30, budgetMs: 33.4 }),
    ]),
  })
  assert.equal(compared.failed, true)
  assert.deepEqual(statuses(compared), [
    ['search/1000/literal', 'fail'],
    ['search/1000/names', 'ok'],
  ])
  const body = report.markdown({ rows: compared.rows, failed: true })
  assert.match(body, /1 workload is over budget/)
  assert.match(body, /median 40\.0 ms > budget 33\.4 ms/)
})

test('a workload over budget warns when the ceiling is over budget on this runner', () => {
  const compared = report.compare({
    reference: reference([
      metric('search/1000/literal', { medianMs: 90, worstMedianMs: 100, budgetMs: 33.4 }),
    ]),
    current: artifact([metric('search/1000/literal', { medianMs: 95, budgetMs: 33.4 })]),
  })
  assert.equal(compared.failed, false)
  assert.deepEqual(statuses(compared), [['search/1000/literal', 'warn']])
  const body = report.markdown({ rows: compared.rows, failed: false })
  assert.match(body, /and so is the ceiling on this runner/)
})

test('a new workload over budget warns because there is no ceiling to judge it', () => {
  const compared = report.compare({
    reference: new Map(),
    current: artifact([metric('search/1000/literal', { medianMs: 40, budgetMs: 33.4 })]),
  })
  assert.equal(compared.failed, false)
  assert.deepEqual(statuses(compared), [['search/1000/literal', 'warn']])
})

test('a workload without a criterion or budget fails', () => {
  const missing = metric('search/1000/literal', { medianMs: 4 })
  delete missing.criterion
  delete missing.budgetMs
  const compared = report.compare({ reference: new Map(), current: artifact([missing]) })
  assert.equal(compared.failed, true)
  assert.deepEqual(statuses(compared), [['search/1000/literal', 'fail']])
  const body = report.markdown({ rows: compared.rows, failed: true })
  assert.match(body, /no criterion declared; no budget declared/)
  assert.match(body, /1 workload declares no criterion/)
})

test('the trusted budget can only be tightened', () => {
  const compared = report.compare({
    reference: reference([metric('search/1000/literal', { medianMs: 4, budgetMs: 16.7 })]),
    current: artifact([metric('search/1000/literal', { medianMs: 4, budgetMs: 100 })]),
    budgets: { 'search/1000/literal': 16.7 },
  })
  assert.equal(compared.failed, true)
  assert.deepEqual(statuses(compared), [['search/1000/literal', 'fail']])
  const body = report.markdown({ rows: compared.rows, failed: true })
  assert.match(body, /budget raised from 16\.7 ms to 100 ms/)
  assert.match(body, /1 workload raised a budget/)
})

test('a budget cannot be raised when the ceiling is not comparable', () => {
  const compared = report.compare({
    reference: new Map([
      [
        'search/1000/literal',
        {
          result: metric('x', { medianMs: 4, budgetMs: 4.5 }),
          sha: SHA,
          recorded: true,
          comparable: false,
        },
      ],
    ]),
    current: artifact([metric('search/1000/literal', { medianMs: 4, budgetMs: 500 })]),
    budgets: { 'search/1000/literal': 4.5 },
  })
  assert.equal(compared.failed, true)
  assert.deepEqual(statuses(compared), [['search/1000/literal', 'fail']])
  assert.match(compared.rows[0].findings[0].note, /budget raised from 4\.50 ms to 500 ms/)
})

test('the ceiling measurement supplies the trusted budget when the floor record has none', () => {
  const ceiling = reference([
    metric('search/1000/literal', { medianMs: 4.5, worstMedianMs: 6, budgetMs: 4.5 }),
  ])
  const raised = report.compare({
    reference: ceiling,
    current: artifact([metric('search/1000/literal', { medianMs: 5.5, budgetMs: 500 })]),
  })
  assert.equal(raised.failed, true)
  assert.match(raised.rows[0].findings[0].note, /budget raised from 4\.50 ms to 500 ms/)

  const omitted = metric('search/1000/literal', { medianMs: 5 })
  delete omitted.budgetMs
  const kept = report.compare({
    reference: ceiling,
    current: artifact([omitted]),
  })
  assert.equal(kept.rows[0].budgetMs, 4.5)
  assert.ok(!kept.rows[0].findings.some((finding) => finding.note === 'no budget declared'))
})

test('the summary counts a failing rule once, not one warning per row', () => {
  const compared = report.compare({
    reference: reference([
      metric('search/1000/literal', {
        medianMs: 90,
        worstMedianMs: 100,
        budgetMs: 33.4,
      }),
    ]),
    current: artifact([metric('search/1000/literal', { medianMs: 200, budgetMs: 33.4 })]),
  })
  assert.equal(compared.failed, true)
  const body = report.markdown({ rows: compared.rows, failed: true })
  const summary = body.match(/❌ [^\n]*/)[0]
  assert.match(summary, /1 workload is slower than the ceiling/)
  assert.doesNotMatch(summary, /over budget/)
})

test('a tighter budget is used as the effective limit', () => {
  const compared = report.compare({
    reference: reference([metric('search/1000/literal', { medianMs: 4, budgetMs: 16.7 })]),
    current: artifact([metric('search/1000/literal', { medianMs: 5, budgetMs: 4 })]),
    budgets: { 'search/1000/literal': 16.7 },
  })
  assert.deepEqual(statuses(compared), [['search/1000/literal', 'fail']])
  assert.match(compared.rows[0].findings[0].note, /budget 4\.00 ms/)
})

test('main is the reference for workloads without a ceiling', () => {
  const base = artifact([
    metric('search/1000/literal', { medianMs: 4, worstMedianMs: 4.4 }),
    metric('syntax/10000/open', { medianMs: 60 }),
  ])
  const current = artifact([
    metric('search/1000/literal', { medianMs: 4.3, p95Ms: 4.3, maxTimerGapMs: 4.3 }),
    metric('syntax/10000/open', { medianMs: 60, p95Ms: 61, maxTimerGapMs: 61 }),
  ])
  const variants = new Map([[OTHER, base]])
  const compared = report.compare({
    reference: report.referenceFor({
      floor: {},
      variants,
      base,
      baseSha: OTHER,
      method: report.METHOD,
    }),
    current,
    base,
  })
  assert.deepEqual(statuses(compared), [
    ['search/1000/literal', 'warn'],
    ['syntax/10000/open', 'ok'],
  ])
  assert.equal(compared.failed, false)
  assert.equal(compared.rows[0].ceilingSha, OTHER)
  assert.equal(compared.rows[0].recorded, false)
  const body = report.markdown({ rows: compared.rows, failed: false })
  assert.match(body, /2 workloads have no ceiling yet and are compared with main/)
})

test('a recorded ceiling is used instead of main', () => {
  const base = artifact([metric('search/1000/literal', { medianMs: 4.3 })])
  const anchor = artifact([metric('search/1000/literal', { medianMs: 4.2 })])
  const current = artifact([metric('search/1000/literal', { medianMs: 4.1 })])
  const reference = report.referenceFor({
    floor: { 'search/1000/literal': SHA },
    variants: new Map([
      [SHA, anchor],
      [OTHER, base],
    ]),
    base,
    baseSha: OTHER,
    method: report.METHOD,
  })
  const compared = report.compare({ reference, current, base })
  assert.equal(compared.rows[0].ceilingSha, SHA)
  assert.equal(compared.rows[0].recorded, true)
  assert.equal(compared.rows[0].status, 'ok')
  assert.ok(Math.abs(compared.rows[0].change - (4.1 / 4.2 - 1) * 100) < 1e-9)
  assert.ok(Math.abs(compared.rows[0].baseChange - (4.1 / 4.3 - 1) * 100) < 1e-9)
})

test('a ceiling and base from another timing method are not used as gates', () => {
  const anchor = artifact([metric('search/1000/literal', { medianMs: 4 })], 1)
  const base = artifact([metric('search/1000/literal', { medianMs: 4 })], 1)
  const current = artifact([metric('search/1000/literal', { medianMs: 9 })], report.METHOD)
  const reference = report.referenceFor({
    floor: { 'search/1000/literal': SHA },
    variants: new Map([
      [SHA, anchor],
      [OTHER, base],
    ]),
    base,
    baseSha: OTHER,
    method: report.METHOD,
  })
  const compared = report.compare({ reference, current, base })
  assert.deepEqual(statuses(compared), [['search/1000/literal', 'new']])
  assert.equal(compared.failed, false)
  const body = report.markdown({ rows: compared.rows, failed: false, methodChanged: true })
  assert.match(body, /changes how workloads are timed/)
})

test('missing ceiling metrics fail while new metrics are reported', () => {
  const ceilings = reference([
    metric('search/1000/literal', { medianMs: 4 }),
    metric('compiler/20-pages/cold', { medianMs: 50 }),
  ])
  const compared = report.compare({
    reference: ceilings,
    current: artifact([
      metric('search/1000/literal', { medianMs: 3.5 }),
      metric('syntax/10000/open', { medianMs: 60 }),
    ]),
  })
  assert.equal(compared.failed, true)
  assert.deepEqual(statuses(compared), [
    ['compiler/20-pages/cold', 'missing'],
    ['search/1000/literal', 'ok'],
    ['syntax/10000/open', 'new'],
  ])
  const body = report.markdown({ rows: compared.rows, failed: true })
  assert.match(body, /1 workload is missing/)
  assert.match(body, /performance-floor/)
})

test('a missing metric that has no ceiling is reported without floor guidance', () => {
  const base = artifact([
    metric('search/1000/literal', { medianMs: 4 }),
    metric('syntax/10000/open', { medianMs: 60 }),
  ])
  const compared = report.compare({
    reference: report.referenceFor({
      floor: { 'search/1000/literal': SHA },
      variants: new Map([[SHA, artifact([metric('search/1000/literal', { medianMs: 4 })])]]),
      base,
      baseSha: OTHER,
      method: report.METHOD,
    }),
    current: artifact([metric('search/1000/literal', { medianMs: 4 })]),
    base,
  })
  assert.equal(compared.failed, true)
  assert.equal(compared.rows.find((row) => row.status === 'missing').recorded, false)
  const body = report.markdown({ rows: compared.rows, failed: true })
  assert.match(body, /1 workload is missing/)
  assert.doesNotMatch(body, /performance-floor/)
})

test('matching the ceiling worst run warns without failing', () => {
  const compared = report.compare({
    reference: reference([
      metric('search/1000/literal', { medianMs: 4, worstMedianMs: 4.4, p95Ms: 7 }),
    ]),
    current: artifact([metric('search/1000/literal', { medianMs: 4.4 })]),
  })
  assert.equal(compared.rows[0].status, 'warn')
  assert.equal(compared.failed, false)
})

test('invalid artifacts and metadata are rejected', () => {
  assert.throws(() => report.validateReport({ results: [] }, 'report'), /runtime/)
  assert.throws(
    () =>
      report.validateReport(
        { runtime: 'bun', os: 'linux', cpu: 'x', results: [{ name: '../bad', samples: 1 }] },
        'report'
      ),
    /name is invalid/
  )
  assert.throws(
    () =>
      report.validateReport(
        artifact([metric('a', { medianMs: 1 }), metric('a', { medianMs: 2 })]),
        'r'
      ),
    /duplicate/
  )
  const noBudget = metric('a', { medianMs: 1 })
  noBudget.budgetMs = 0
  assert.throws(() => report.validateReport(artifact([noBudget]), 'r'), /budgetMs/)
  assert.throws(
    () => report.validateMeta({ kind: 'merge', headSha: SHA, baseSha: null, floor: {} }, 'meta'),
    /kind/
  )
  assert.throws(
    () =>
      report.validateMeta(
        { kind: 'pull_request', headSha: 'nope', baseSha: null, floor: {} },
        'meta'
      ),
    /headSha/
  )
  assert.throws(
    () =>
      report.validateMeta(
        { kind: 'pull_request', headSha: SHA, baseSha: null, floor: { x: 'nope' } },
        'meta'
      ),
    /floor\.x/
  )
  assert.throws(
    () =>
      report.validateMeta(
        { kind: 'pull_request', headSha: SHA, baseSha: null, floor: {}, budgets: { x: 0 } },
        'meta'
      ),
    /budgets\.x/
  )
})

test('the CLI reads the artifact directory and writes the comparison', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typo-performance-'))
  try {
    const out = path.join(directory, 'comment.md')
    const result = path.join(directory, 'result.txt')
    const anchor = artifact([
      metric('search/1000/literal', { medianMs: 4 }),
      metric('syntax/10000/open', { medianMs: 60 }),
    ])
    const base = artifact([
      metric('search/1000/literal', { medianMs: 4, budgetMs: 33.4 }),
      metric('syntax/10000/open', { medianMs: 60, worstMedianMs: 65 }),
    ])
    const head = artifact([
      metric('search/1000/literal', { medianMs: 4, budgetMs: 33.4 }),
      metric('syntax/10000/open', { medianMs: 62 }),
    ])
    fs.writeFileSync(path.join(directory, `${SHA}.json`), JSON.stringify(anchor))
    fs.writeFileSync(path.join(directory, `${OTHER}.json`), JSON.stringify(base))
    fs.writeFileSync(path.join(directory, `${'c'.repeat(40)}.json`), JSON.stringify(head))
    fs.writeFileSync(
      path.join(directory, 'meta.json'),
      JSON.stringify({
        kind: 'pull_request',
        headSha: 'c'.repeat(40),
        baseSha: OTHER,
        floor: { 'search/1000/literal': SHA },
        budgets: { 'search/1000/literal': 33.4 },
      })
    )
    const { execFileSync } = require('node:child_process')
    execFileSync('node', [
      path.join(__dirname, 'performance-report.cjs'),
      '--dir',
      directory,
      '--out',
      out,
      '--result',
      result,
    ])
    assert.equal(fs.readFileSync(result, 'utf8').trim(), 'pass')
    const comment = fs.readFileSync(out, 'utf8')
    assert.match(comment, /Ceilings: `aaaaaaa` \(1\)/)
    assert.match(comment, /1 workload has no ceiling yet and is compared with main/)
    assert.match(comment, /syntax\/10000\/open/)
    assert.match(comment, /test criterion/)
    assert.throws(() =>
      execFileSync('node', [
        path.join(__dirname, 'performance-report.cjs'),
        '--out',
        out,
        '--result',
        result,
      ])
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
