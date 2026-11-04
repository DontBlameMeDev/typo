const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const report = require('./performance-report.cjs')

function artifact(results) {
  return {
    runtime: 'Bun 1.4.2',
    os: 'linux',
    cpu: 'test',
    results: results.map(([name, medianMs, samples = 15]) => ({
      name,
      samples,
      medianMs,
      p95Ms: medianMs * 1.2,
      maxTimerGapMs: 1,
    })),
  }
}

test('faster and unchanged metrics pass, and slower metrics warn or fail', () => {
  const base = artifact([
    ['search/1000/literal', 100],
    ['syntax/1000/open', 10],
    ['compiler/1-pages/cold', 50],
    ['workspace/1000-files/unchanged-refresh', 2],
  ])
  const current = artifact([
    ['search/1000/literal', 50],
    ['syntax/1000/open', 10.1],
    ['compiler/1-pages/cold', 52],
    ['workspace/1000-files/unchanged-refresh', 5.5],
  ])
  const compared = report.compare(base, current)
  assert.equal(compared.failed, true)
  assert.deepEqual(
    compared.rows.map((row) => row.status),
    ['ok', 'ok', 'warn', 'fail']
  )
  const body = report.markdown({
    baseSha: 'a'.repeat(40),
    baseRun: 1,
    prSha: 'b'.repeat(40),
    prRun: 2,
    rows: compared.rows,
    failed: true,
  })
  assert.match(body, /regressed by more than 5%/)
  assert.match(body, /-50\.0%/)
  assert.match(body, /\+4.0%/)
  assert.match(body, /\+175\.0%/)
})

test('warnings alone pass but are called out', () => {
  const failed = report.compare(
    artifact([['search/1000/literal', 100]]),
    artifact([['search/1000/literal', 110]])
  )
  assert.equal(failed.failed, true)
  assert.equal(failed.rows[0].status, 'fail')
  const warned = report.compare(
    artifact([['search/1000/literal', 100]]),
    artifact([['search/1000/literal', 104]])
  )
  assert.equal(warned.failed, false)
  const body = report.markdown({ rows: warned.rows, failed: false })
  assert.match(body, /slowed by more than 2%/)
})

test('missing baseline metrics fail while new metrics are reported', () => {
  const compared = report.compare(
    artifact([
      ['search/1000/literal', 100],
      ['compiler/1-pages/cold', 50],
    ]),
    artifact([
      ['search/1000/literal', 90],
      ['syntax/1000/open', 5],
    ])
  )
  assert.equal(compared.failed, true)
  assert.deepEqual(
    compared.rows.map((row) => [row.name, row.status]),
    [
      ['search/1000/literal', 'ok'],
      ['compiler/1-pages/cold', 'missing'],
      ['syntax/1000/open', 'new'],
    ]
  )
})

test('invalid artifacts are rejected', () => {
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
})

test('the CLI writes a pending report without a baseline', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typo-performance-'))
  try {
    const pr = path.join(directory, 'pr.json')
    fs.writeFileSync(pr, JSON.stringify(artifact([['search/1000/literal', 100]])))
    const out = path.join(directory, 'comment.md')
    const result = path.join(directory, 'result.txt')
    const { execFileSync } = require('node:child_process')
    execFileSync('node', [
      path.join(__dirname, 'performance-report.cjs'),
      '--pr',
      pr,
      '--out',
      out,
      '--result',
      result,
      '--pr-sha',
      'a'.repeat(40),
      '--pr-run',
      '7',
    ])
    assert.equal(fs.readFileSync(result, 'utf8').trim(), 'pending')
    assert.match(fs.readFileSync(out, 'utf8'), /No `main` baseline/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
