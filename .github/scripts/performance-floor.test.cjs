const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const floorScript = require('./performance-floor.cjs')

const MAIN = '1'.repeat(40)
const OLD = '2'.repeat(40)
const HEAD = '3'.repeat(40)
const NOW = '2026-11-05T00:00:00.000Z'

function artifact(results) {
  return {
    runtime: 'Bun 1.4.2',
    os: 'linux',
    cpu: 'test',
    results: results.map(([name, medianMs, worstMedianMs = medianMs, noisePercent = 0]) => ({
      name,
      samples: 15,
      medianMs,
      worstMedianMs,
      p95Ms: medianMs * 1.2,
      maxTimerGapMs: 1,
      noisePercent,
    })),
  }
}

function record(sha, medianMs, worstMedianMs = medianMs) {
  return { sha, medianMs, worstMedianMs, updatedAt: NOW }
}

function meta(floor) {
  return {
    kind: 'push',
    headSha: HEAD,
    baseSha: null,
    floor: Object.fromEntries(Object.entries(floor).map(([name, entry]) => [name, entry.sha])),
  }
}

test('the first main run records every gated workload', () => {
  const head = artifact([
    ['search/1000/literal', 40],
    ['syntax/10000/open', 100],
    ['search/1000/missing', 50],
    ['syntax/1000/scroll', 2],
  ])
  const { floor, changes } = floorScript.updateFloor({
    floor: floorScript.emptyFloor(),
    meta: meta({}),
    variants: new Map([[HEAD, head]]),
    now: NOW,
  })
  assert.deepEqual(Object.keys(floor.metrics).sort(), ['search/1000/literal', 'syntax/10000/open'])
  assert.deepEqual(floor.metrics['search/1000/literal'], record(HEAD, 40))
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

test('a slightly better or noisier run does not raise the ceiling', () => {
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
  // The literal win is inside the anchor's spread, and the syntax run is too noisy to trust.
  variants.get(HEAD).results[0].worstMedianMs = 101
  variants.get(HEAD).results[1].noisePercent = 20
  const { floor: next, changes } = floorScript.updateFloor({
    floor,
    meta: meta(floor.metrics),
    variants,
    now: NOW,
  })
  assert.equal(changes.length, 0)
  assert.deepEqual(next.metrics, floor.metrics)
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
  assert.equal(changes.length, 0)
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
