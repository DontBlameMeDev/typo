import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'typo-aggregate-'))
afterAll(() => rm(directory, { recursive: true, force: true }))

function report(values: number[]) {
  return {
    runtime: 'Bun',
    os: 'linux',
    cpu: 'test',
    results: values.map((medianMs, index) => ({
      name: `metric/${index}`,
      samples: 15,
      medianMs,
      p95Ms: medianMs * 1.2,
      maxTimerGapMs: 2,
    })),
  }
}

test('aggregation keeps the best value from the repeated runs', async () => {
  for (const [index, [base, pr]] of [
    [100, 50],
    [90, 60],
    [110, 70],
  ].entries()) {
    await writeFile(join(directory, `base-${index + 1}.json`), JSON.stringify(report([base])))
    await writeFile(join(directory, `pr-${index + 1}.json`), JSON.stringify(report([pr])))
  }
  const child = Bun.spawn(
    ['bun', 'scripts/performance-aggregate.ts', directory, 'base-sha', 'pr-sha', '3'],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  expect(await child.exited).toBe(0)
  const base = JSON.parse(await readFile(join(directory, 'base.json'), 'utf8'))
  const pr = JSON.parse(await readFile(join(directory, 'pr.json'), 'utf8'))
  const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8'))
  expect(base.results[0].medianMs).toBe(90)
  expect(pr.results[0].medianMs).toBe(50)
  expect(meta).toEqual({ baseSha: 'base-sha', prSha: 'pr-sha' })
})

test('aggregation rejects runs with different metrics', async () => {
  for (let index = 1; index <= 3; index++) {
    await writeFile(join(directory, `base-${index}.json`), JSON.stringify(report([100])))
    await writeFile(join(directory, `pr-${index}.json`), JSON.stringify(report([50])))
  }
  const changed = report([50, 10])
  await writeFile(join(directory, 'pr-3.json'), JSON.stringify(changed))
  const child = Bun.spawn(
    ['bun', 'scripts/performance-aggregate.ts', directory, 'base-sha', 'pr-sha', '3'],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  expect(await child.exited).not.toBe(0)
})
