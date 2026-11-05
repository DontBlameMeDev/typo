const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const report = require('./performance-report.cjs')

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

function artifact(results) {
  return {
    runtime: 'Bun 1.4.2',
    os: 'linux',
    cpu: 'test',
    results: results.map(([name, medianMs, samples = 15]) => ({
      name,
      samples,
      medianMs,
      worstMedianMs: medianMs,
      p95Ms: medianMs * 1.2,
      maxTimerGapMs: 1,
      noisePercent: 0,
    })),
  }
}

function ceiling(medianMs, sha = SHA) {
  return {
    result: {
      name: 'x',
      samples: 15,
      medianMs,
      worstMedianMs: medianMs,
      p95Ms: medianMs * 1.2,
      maxTimerGapMs: 1,
      noisePercent: 0,
    },
    sha,
  }
}

test('gated metrics pass, warn, or fail against their ceiling', () => {
  const reference = new Map([
    ['search/1000/literal', ceiling(100)],
    ['syntax/10000/open', ceiling(10)],
    ['compiler/1-pages/cold', ceiling(50)],
    ['workspace/1000-files/changed-refresh', ceiling(20)],
  ])
  const current = artifact([
    ['search/1000/literal', 50],
    ['syntax/10000/open', 10.1],
    ['compiler/1-pages/cold', 52],
    ['workspace/1000-files/changed-refresh', 21.2],
  ])
  const compared = report.compare({ reference, current })
  assert.equal(compared.failed, true)
  assert.deepEqual(
    compared.rows.map((row) => row.status),
    ['warn', 'ok', 'ok', 'fail']
  )
  const body = report.markdown({ rows: compared.rows, failed: true })
  assert.match(body, /1 workload is more than 5% above the ceiling/)
  assert.match(body, /-50\.0%/)
  assert.match(body, /\+1\.0%/)
  assert.match(body, /\+4\.0%/)
  assert.match(body, /\+6\.0%/)
})

test('each metric keeps its own ceiling', () => {
  const reference = new Map([
    ['search/1000/literal', ceiling(98)],
    ['syntax/10000/open', ceiling(52)],
  ])
  const current = artifact([
    ['search/1000/literal', 100],
    ['syntax/10000/open', 52],
  ])
  const compared = report.compare({ reference, current })
  assert.deepEqual(
    compared.rows.map((row) => [row.name, row.status]),
    [
      ['search/1000/literal', 'warn'],
      ['syntax/10000/open', 'ok'],
    ]
  )
})

test('main is the reference for workloads without a ceiling', () => {
  const base = artifact([
    ['search/1000/literal', 100],
    ['syntax/10000/open', 20],
  ])
  const current = artifact([
    ['search/1000/literal', 104],
    ['syntax/10000/open', 20],
  ])
  const variants = new Map([[OTHER, base]])
  const reference = report.referenceFor({
    floor: { 'search/1000/literal': SHA },
    variants,
    base,
    baseSha: OTHER,
  })
  const compared = report.compare({ reference, current, base })
  assert.equal(compared.rows[0].ceilingSha, OTHER)
  assert.equal(compared.rows[0].status, 'warn')
  assert.equal(compared.rows[1].ceilingSha, OTHER)
  assert.equal(compared.rows[1].status, 'ok')
})

test('a recorded ceiling is used instead of main', () => {
  const base = artifact([['search/1000/literal', 102]])
  const anchor = artifact([['search/1000/literal', 100]])
  const variants = new Map([
    [SHA, anchor],
    [OTHER, base],
  ])
  const current = artifact([['search/1000/literal', 104]])
  const reference = report.referenceFor({
    floor: { 'search/1000/literal': SHA },
    variants,
    base,
    baseSha: OTHER,
  })
  const compared = report.compare({ reference, current, base })
  assert.equal(compared.rows[0].ceilingMs, 100)
  assert.equal(compared.rows[0].ceilingSha, SHA)
  assert.ok(Math.abs(compared.rows[0].change - 4) < 1e-9)
  assert.ok(Math.abs(compared.rows[0].baseChange - (104 / 102 - 1) * 100) < 1e-9)
  assert.equal(compared.rows[0].status, 'warn')
})

test('noisy ceilings and ceilings below the gate are informational', () => {
  const reference = new Map([
    ['search/1000/missing', ceiling(100)],
    ['search/1000/literal', ceiling(100)],
    ['syntax/1000/scroll', ceiling(2)],
  ])
  reference.get('search/1000/literal').result.noisePercent = 20
  const current = artifact([
    ['search/1000/missing', 150],
    ['search/1000/literal', 150],
    ['syntax/1000/scroll', 5],
  ])
  const compared = report.compare({ reference, current })
  assert.equal(compared.failed, false)
  assert.deepEqual(
    compared.rows.map((row) => row.status),
    ['info', 'info', 'info']
  )
})

test('overlapping runs are informational even above 5%', () => {
  const before = ceiling(100)
  before.result.worstMedianMs = 110
  const compared = report.compare({
    reference: new Map([['syntax/1000/open', before]]),
    current: artifact([['syntax/1000/open', 106]]),
  })
  assert.equal(compared.failed, false)
  assert.equal(compared.rows[0].status, 'info')
})

test('missing ceiling metrics fail while new metrics are reported', () => {
  const reference = new Map([
    ['search/1000/literal', ceiling(100)],
    ['compiler/20-pages/cold', ceiling(50)],
  ])
  const current = artifact([
    ['search/1000/literal', 90],
    ['syntax/10000/open', 15],
  ])
  const compared = report.compare({ reference, current })
  assert.equal(compared.failed, true)
  assert.deepEqual(
    compared.rows.map((row) => [row.name, row.status]),
    [
      ['compiler/20-pages/cold', 'missing'],
      ['search/1000/literal', 'ok'],
      ['syntax/10000/open', 'new'],
    ]
  )
  const body = report.markdown({ rows: compared.rows, failed: true })
  assert.match(body, /performance-floor/)
})

test('a missing metric that has no ceiling is reported without floor guidance', () => {
  const base = artifact([
    ['search/1000/literal', 100],
    ['syntax/10000/open', 20],
  ])
  const reference = report.referenceFor({
    floor: { 'search/1000/literal': SHA },
    variants: new Map([[SHA, artifact([['search/1000/literal', 100]])]]),
    base,
    baseSha: OTHER,
  })
  const compared = report.compare({
    reference,
    current: artifact([['search/1000/literal', 100]]),
    base,
  })
  assert.equal(compared.failed, true)
  assert.equal(compared.rows.find((row) => row.status === 'missing').recorded, false)
  const body = report.markdown({ rows: compared.rows, failed: true })
  assert.match(body, /1 workload is missing from this PR/)
  assert.doesNotMatch(body, /performance-floor/)
})

test('warnings alone pass but are called out', () => {
  const warned = report.compare({
    reference: new Map([['search/1000/literal', ceiling(100)]]),
    current: artifact([['search/1000/literal', 104]]),
  })
  assert.equal(warned.failed, false)
  const body = report.markdown({ rows: warned.rows, failed: false })
  assert.match(body, /more than 2% above it/)
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
  const duplicate = artifact([
    ['a', 1],
    ['a', 2],
  ])
  assert.throws(() => report.validateReport(duplicate, 'report'), /duplicate/)
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
})

test('the CLI reads the artifact directory and writes the comparison', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typo-performance-'))
  try {
    const out = path.join(directory, 'comment.md')
    const result = path.join(directory, 'result.txt')
    const anchor = artifact([
      ['search/1000/literal', 100],
      ['syntax/10000/open', 20],
    ])
    const base = artifact([
      ['search/1000/literal', 101],
      ['syntax/10000/open', 20],
    ])
    const head = artifact([
      ['search/1000/literal', 104],
      ['syntax/10000/open', 20.4],
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
    assert.match(fs.readFileSync(out, 'utf8'), /2 are more than 2% above it/)
    assert.match(fs.readFileSync(out, 'utf8'), /Ceilings: `aaaaaaa` \(1\)/)
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
