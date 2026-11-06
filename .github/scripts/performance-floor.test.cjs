const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const floorScript = require('./performance-floor.cjs')
const { METHOD } = require('./performance-report.cjs')

const MAIN = '1'.repeat(40)
const OLD = '2'.repeat(40)
const HEAD = '3'.repeat(40)
const NOW = '2026-11-05T00:00:00.000Z'

function artifact(results) {
  return {
    method: METHOD,
    runtime: 'Bun 1.4.2',
    os: 'linux',
    cpu: 'test',
    results: results.map(
      ([name, medianMs, worstMedianMs = medianMs, budgetMs = 100, noisePercent = 0]) => ({
        name,
        criterion: 'test criterion',
        budgetMs,
        samples: 15,
        repeat: 1,
        medianMs,
        worstMedianMs,
        p95Ms: medianMs * 1.2,
        worstP95Ms: worstMedianMs * 1.2,
        maxTimerGapMs: 1,
        worstTimerGapMs: 2,
        noisePercent,
      })
    ),
  }
}

function record(sha, medianMs, worstMedianMs = medianMs, budgetMs = 100) {
  return { sha, method: METHOD, medianMs, worstMedianMs, budgetMs, updatedAt: NOW }
}

function meta(floor) {
  return {
    kind: 'push',
    headSha: HEAD,
    baseSha: null,
    floor: Object.fromEntries(Object.entries(floor).map(([name, entry]) => [name, entry.sha])),
    budgets: Object.fromEntries(
      Object.entries(floor).map(([name, entry]) => [name, entry.budgetMs])
    ),
  }
}

test('the first main run records every measured workload with its budget', () => {
  const head = artifact([
    ['search/1000/literal', 40, 40, 33.4],
    ['search/1000/missing', 50, 50, 33.4],
  ])
  const { floor, changes } = floorScript.updateFloor({
    floor: floorScript.emptyFloor(),
    meta: meta({}),
    variants: new Map([[HEAD, head]]),
    now: NOW,
  })
  assert.deepEqual(Object.keys(floor.metrics).sort(), [
    'search/1000/literal',
    'search/1000/missing',
  ])
  assert.deepEqual(floor.metrics['search/1000/literal'], record(HEAD, 40, 40, 33.4))
  assert.equal(changes.length, 2)
})

test('only the workload that improved gets a new ceiling', () => {
  const floor = {
    version: 1,
    metrics: {
      'search/1000/literal': record(OLD, 100),
      'syntax/10000/open': record(OLD, 100),
    },
  }
  const variants = new Map([
    [
      OLD,
      artifact([
        ['search/1000/literal', 100],
        ['syntax/10000/open', 100],
      ]),
    ],
    [
      HEAD,
      artifact([
        ['search/1000/literal', 98],
        ['syntax/10000/open', 101],
      ]),
    ],
  ])
  const { floor: next, changes } = floorScript.updateFloor({
    floor,
    meta: meta(floor.metrics),
    variants,
    now: NOW,
  })
  assert.equal(next.metrics['search/1000/literal'].sha, HEAD)
  assert.equal(next.metrics['search/1000/literal'].medianMs, 98)
  assert.equal(next.metrics['syntax/10000/open'].sha, OLD)
  assert.deepEqual(
    changes.map((change) => change.name),
    ['search/1000/literal']
  )
})

test('an improvement only lowers the ceiling when its worst run beats the recorded best', () => {
  const floor = {
    version: 1,
    metrics: {
      'search/1000/literal': record(OLD, 100),
      'syntax/10000/open': record(OLD, 100),
    },
  }
  const variants = new Map([
    [
      OLD,
      artifact([
        ['search/1000/literal', 100],
        ['syntax/10000/open', 100],
      ]),
    ],
    [
      HEAD,
      artifact([
        ['search/1000/literal', 99],
        ['syntax/10000/open', 90],
      ]),
    ],
  ])
  // The literal win is inside the anchor's spread, so it cannot raise the ceiling.
  variants.get(HEAD).results[0].worstMedianMs = 101
  const { floor: next, changes } = floorScript.updateFloor({
    floor,
    meta: meta(floor.metrics),
    variants,
    now: NOW,
  })
  assert.deepEqual(
    changes.map((change) => change.name),
    ['syntax/10000/open']
  )
  assert.equal(next.metrics['search/1000/literal'].sha, OLD)
  assert.equal(next.metrics['syntax/10000/open'].medianMs, 90)
})

test('a run that measured an older anchor leaves the ceiling alone', () => {
  const floor = {
    version: 1,
    metrics: { 'search/1000/literal': record(MAIN, 90) },
  }
  const stale = {
    kind: 'push',
    headSha: HEAD,
    baseSha: null,
    floor: { 'search/1000/literal': OLD },
    budgets: { 'search/1000/literal': 100 },
  }
  const variants = new Map([
    [OLD, artifact([['search/1000/literal', 100]])],
    [HEAD, artifact([['search/1000/literal', 50]])],
  ])
  const { changes } = floorScript.updateFloor({
    floor,
    meta: stale,
    variants,
    now: NOW,
  })
  assert.equal(changes.length, 0)
})

test('a tightened budget is recorded with the ceiling', () => {
  const floor = {
    version: 1,
    metrics: { 'search/1000/literal': record(OLD, 100, 100, 33.4) },
  }
  const variants = new Map([
    [OLD, artifact([['search/1000/literal', 100, 100, 33.4]])],
    [HEAD, artifact([['search/1000/literal', 80, 80, 16.7]])],
  ])
  const { floor: next } = floorScript.updateFloor({
    floor,
    meta: meta(floor.metrics),
    variants,
    now: NOW,
  })
  assert.equal(next.metrics['search/1000/literal'].budgetMs, 16.7)
})

test('a loosened budget never replaces the recorded one', () => {
  const floor = {
    version: 1,
    metrics: { 'search/1000/literal': record(OLD, 100, 100, 16.7) },
  }
  const variants = new Map([
    [OLD, artifact([['search/1000/literal', 100, 100, 16.7]])],
    [HEAD, artifact([['search/1000/literal', 80, 80, 33.4]])],
  ])
  const { floor: next } = floorScript.updateFloor({
    floor,
    meta: meta(floor.metrics),
    variants,
    now: NOW,
  })
  assert.equal(next.metrics['search/1000/literal'].budgetMs, 16.7)
})

test('removed workloads keep their ceiling until the entry is deleted', () => {
  const floor = {
    version: 1,
    metrics: { 'compiler/20-pages/cold': record(OLD, 100) },
  }
  const { floor: next, changes } = floorScript.updateFloor({
    floor,
    meta: meta(floor.metrics),
    variants: new Map([
      [OLD, artifact([['compiler/20-pages/cold', 100]])],
      [HEAD, artifact([['search/1000/literal', 4]])],
    ]),
    now: NOW,
  })
  assert.deepEqual(next.metrics['compiler/20-pages/cold'], record(OLD, 100))
  assert.deepEqual(
    changes.map((change) => change.name),
    ['search/1000/literal']
  )
})

test('ceilings from another timing method are dropped', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typo-floor-read-'))
  try {
    const file = path.join(directory, 'floor.json')
    const old = record(OLD, 100)
    delete old.method
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        metrics: { 'search/1000/literal': old, 'syntax/10000/open': record(MAIN, 50) },
      })
    )
    const planned = require('node:child_process').execFileSync('node', [
      path.join(__dirname, 'performance-floor.cjs'),
      'plan',
      '--floor',
      file,
      '--head',
      HEAD,
      '--kind',
      'push',
      '--meta',
      path.join(directory, 'meta.json'),
    ])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'meta.json'), 'utf8')), {
      kind: 'push',
      headSha: HEAD,
      baseSha: null,
      floor: { 'syntax/10000/open': MAIN },
      budgets: { 'syntax/10000/open': 100 },
    })
    assert.match(planned.toString(), new RegExp(MAIN))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('planning includes main and each distinct ceiling commit', () => {
  const floor = {
    version: 1,
    metrics: {
      'search/1000/literal': record(OLD, 100),
      'syntax/10000/open': record(MAIN, 100),
    },
  }
  assert.deepEqual(
    floorScript.variantShas({ floor, headSha: HEAD, baseSha: MAIN }),
    [OLD, MAIN].sort()
  )
  assert.deepEqual(floorScript.mapping(floor), {
    'search/1000/literal': OLD,
    'syntax/10000/open': MAIN,
  })
  assert.deepEqual(floorScript.budgets(floor), {
    'search/1000/literal': 100,
    'syntax/10000/open': 100,
  })
})

test('invalid ceilings are rejected', () => {
  assert.throws(() => floorScript.validateFloor({ version: 2, metrics: {} }), /version/)
  assert.throws(
    () => floorScript.validateFloor({ version: 1, metrics: { x: { sha: 'nope' } } }),
    /sha/
  )
  assert.throws(
    () =>
      floorScript.validateFloor({
        version: 1,
        metrics: { x: record(OLD, 100, 90) },
      }),
    /worstMedianMs/
  )
  assert.throws(
    () =>
      floorScript.validateFloor({
        version: 1,
        metrics: { x: { ...record(OLD, 100), budgetMs: 0 } },
      }),
    /budgetMs/
  )
})

test('updating rejects a head measurement from another method', () => {
  const head = artifact([['search/1000/literal', 80]])
  head.method = 1
  assert.throws(
    () =>
      floorScript.updateFloor({
        floor: floorScript.emptyFloor(),
        meta: meta({}),
        variants: new Map([[HEAD, head]]),
        now: NOW,
      }),
    /method/
  )
  assert.throws(
    () =>
      floorScript.validateFloor({
        version: 1,
        metrics: {
          x: { ...record(OLD, 100), worstMedianMs: Number.NaN },
        },
      }),
    /worstMedianMs/
  )
})

test('the CLI plans and updates the ceiling', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typo-floor-'))
  try {
    const floorPath = path.join(directory, 'floor.json')
    const metaPath = path.join(directory, 'meta.json')
    const marker = path.join(directory, 'changed.txt')
    const { execFileSync } = require('node:child_process')
    const cli = path.join(__dirname, 'performance-floor.cjs')

    fs.writeFileSync(
      floorPath,
      JSON.stringify({
        version: 1,
        metrics: { 'search/1000/literal': record(OLD, 100) },
      })
    )
    const planned = execFileSync('node', [
      cli,
      'plan',
      '--floor',
      floorPath,
      '--head',
      HEAD,
      '--base',
      '',
      '--kind',
      'push',
      '--meta',
      metaPath,
    ])
      .toString()
      .trim()
      .split('\n')
    assert.deepEqual(planned, [OLD])
    const metaValue = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    assert.deepEqual(metaValue, {
      kind: 'push',
      headSha: HEAD,
      baseSha: null,
      floor: { 'search/1000/literal': OLD },
      budgets: { 'search/1000/literal': 100 },
    })

    fs.writeFileSync(
      path.join(directory, `${OLD}.json`),
      JSON.stringify(artifact([['search/1000/literal', 100]]))
    )
    fs.writeFileSync(
      path.join(directory, `${HEAD}.json`),
      JSON.stringify(artifact([['search/1000/literal', 80]]))
    )
    execFileSync('node', [
      cli,
      'update',
      '--floor',
      floorPath,
      '--meta',
      metaPath,
      '--dir',
      directory,
      '--out',
      floorPath,
      '--marker',
      marker,
      '--now',
      NOW,
    ])
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'changed')
    assert.equal(
      JSON.parse(fs.readFileSync(floorPath, 'utf8')).metrics['search/1000/literal'].sha,
      HEAD
    )

    execFileSync('node', [
      cli,
      'update',
      '--floor',
      floorPath,
      '--meta',
      metaPath,
      '--dir',
      directory,
      '--out',
      floorPath,
      '--marker',
      marker,
      '--now',
      NOW,
    ])
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'unchanged')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
