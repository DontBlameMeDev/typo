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

function report(values: number[], names = values.map((_, index) => `metric/${index}`)) {
  return {
    runtime: 'Bun',
    os: 'linux',
    cpu: 'test',
    results: values.map((medianMs, index) => ({
      name: names[index],
      samples: 15,
      medianMs,
      p95Ms: medianMs * 1.2,
      maxTimerGapMs: 2,
      noisePercent: 0,
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

test('aggregation keeps the best value from the repeated runs', async () => {
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
  expect(base.results[0].medianMs).toBe(90)
  expect(base.results[0].worstMedianMs).toBe(110)
  expect(base.results[0].noisePercent).toBeCloseTo(22.22, 1)
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
