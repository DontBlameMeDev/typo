import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'typo-aggregate-'))
const input = join(directory, 'raw')
const output = join(directory, 'out')
afterAll(() => rm(directory, { recursive: true, force: true }))

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

function report(
  values: number[],
  names = values.map((_, index) => `metric/${index}`),
  budgetMs = 100
) {
  return {
    method: 2,
    runtime: 'Bun',
    os: 'linux',
    cpu: 'test',
    results: values.map((medianMs, index) => ({
      name: names[index],
      criterion: 'test criterion',
      budgetMs,
      samples: 15,
      repeat: 1,
      medianMs,
      p95Ms: medianMs * 1.2,
      maxTimerGapMs: medianMs * 1.1,
    })),
  }
}

async function writeRun(sha: string, round: number, value: number | number[], names?: string[]) {
  await Bun.write(
    join(input, `${sha}-${round}.json`),
    JSON.stringify(Array.isArray(value) ? report(value, names) : report([value]))
  )
}

function run() {
  return Bun.spawn(['bun', 'scripts/performance-aggregate.ts', input, output, '3'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

test('aggregation keeps the best run and the worst run of every statistic', async () => {
  await rm(input, { recursive: true, force: true })
  for (const [index, [base, head]] of [
    [100, 50],
    [90, 60],
    [110, 70],
  ].entries()) {
    await writeRun(BASE, index + 1, base)
    await writeRun(HEAD, index + 1, head)
  }
  const child = run()
  expect(await child.exited).toBe(0)
  const base = JSON.parse(await readFile(join(output, `${BASE}.json`), 'utf8'))
  const pr = JSON.parse(await readFile(join(output, `${HEAD}.json`), 'utf8'))
  expect(base.method).toBe(2)
  expect(base.results[0].medianMs).toBe(90)
  expect(base.results[0].worstMedianMs).toBe(110)
  expect(base.results[0].p95Ms).toBeCloseTo(108)
  expect(base.results[0].worstP95Ms).toBeCloseTo(132)
  expect(base.results[0].maxTimerGapMs).toBeCloseTo(99)
  expect(base.results[0].worstTimerGapMs).toBeCloseTo(121)
  expect(base.results[0].noisePercent).toBeCloseTo(22.22, 1)
  expect(base.results[0].criterion).toBe('test criterion')
  expect(base.results[0].budgetMs).toBe(100)
  expect(pr.results[0].medianMs).toBe(50)
  expect(pr.results[0].worstMedianMs).toBe(70)
  expect(pr.results[0].noisePercent).toBeCloseTo(40, 1)
})

test('aggregation rejects a missing round', async () => {
  await rm(input, { recursive: true, force: true })
  for (let round = 1; round <= 2; round++) await writeRun(BASE, round, 100)
  const child = run()
  expect(await child.exited).not.toBe(0)
})

test('aggregation rejects runs with different metrics', async () => {
  await rm(input, { recursive: true, force: true })
  for (let round = 1; round <= 3; round++) await writeRun(BASE, round, 100)
  await writeRun(BASE, 3, [50, 10], ['metric/0', 'metric/1'])
  const child = run()
  expect(await child.exited).not.toBe(0)
})

test('aggregation rejects runs that disagree about a criterion or budget', async () => {
  await rm(input, { recursive: true, force: true })
  for (let round = 1; round <= 3; round++) await writeRun(BASE, round, 100)
  const file = join(input, `${BASE}-3.json`)
  const changed = report([100])
  changed.results[0].budgetMs = 200
  await Bun.write(file, JSON.stringify(changed))
  const child = run()
  expect(await child.exited).not.toBe(0)
})

test('aggregation rejects runs measured in different ways', async () => {
  await rm(input, { recursive: true, force: true })
  for (let round = 1; round <= 3; round++) await writeRun(BASE, round, 100)
  const file = join(input, `${BASE}-3.json`)
  await Bun.write(file, JSON.stringify({ ...report([100]), method: 1 }))
  const child = run()
  expect(await child.exited).not.toBe(0)
})

test('aggregation rejects a round with a missing or non-finite statistic', async () => {
  await rm(input, { recursive: true, force: true })
  for (let round = 1; round <= 3; round++) await writeRun(BASE, round, 100)
  const broken = report([100])
  ;(broken.results[0] as { maxTimerGapMs: unknown }).maxTimerGapMs = null
  await Bun.write(join(input, `${BASE}-2.json`), JSON.stringify(broken))
  const child = run()
  expect(await child.exited).not.toBe(0)
})

test('aggregation rejects rounds from different runners', async () => {
  await rm(input, { recursive: true, force: true })
  for (let round = 1; round <= 3; round++) await writeRun(BASE, round, 100)
  const moved = report([100])
  moved.cpu = 'another cpu'
  await Bun.write(join(input, `${BASE}-3.json`), JSON.stringify(moved))
  const child = run()
  expect(await child.exited).not.toBe(0)
})

test('aggregation ignores unrelated files', async () => {
  await rm(input, { recursive: true, force: true })
  await Bun.write(join(input, 'meta.json'), '{}')
  for (let round = 1; round <= 3; round++) await writeRun(BASE, round, 100)
  await Bun.write(join(output, 'stale.json'), '{}')
  const child = run()
  expect(await child.exited).toBe(0)
  const base = JSON.parse(await readFile(join(output, `${BASE}.json`), 'utf8'))
  expect(base.results[0].medianMs).toBe(100)
})
