import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'typo-coverage-'))
afterAll(() => rm(directory, { recursive: true, force: true }))

const report = (covered: number, valid: number) => `<?xml version="1.0" ?>
<coverage line-rate="0.9" branch-rate="0" lines-covered="${covered}" lines-valid="${valid}" branches-covered="0" branches-valid="0" complexity="0" version="0.1">
  <packages>
    <package name="src" line-rate="0.9" branch-rate="0" complexity="0">
      <classes>
        <class name="src/a.ts" filename="src/a.ts" line-rate="0.9" branch-rate="0" complexity="0">
          <methods/>
          <lines/>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`

async function run(name: string, current: string, baseline?: string, minimum = 80) {
  const input = join(directory, `${name}.xml`)
  const output = join(directory, `${name}.md`)
  await writeFile(input, current)
  if (baseline) await writeFile(join(directory, `${name}-baseline.xml`), baseline)
  const child = Bun.spawn(['bun', 'scripts/coverage-check.ts', input, String(minimum), output], {
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SERVER_URL: 'https://github.com',
      HEAD_SHA: 'abcdef0123456',
      ...(baseline && {
        BASELINE_COVERAGE: join(directory, `${name}-baseline.xml`),
        BASELINE_SHA: '1234567890abc',
      }),
    },
  })
  const code = await child.exited
  const body = await readFile(output, 'utf8')
  return { code, body }
}

test('coverage impact compares the PR with main and links both commits', async () => {
  const { code, body } = await run('improved', report(95, 100), report(90, 100))
  expect(code).toBe(0)
  expect(body).toContain('### Coverage impact')
  expect(body).toContain('| Lines | 90.0% (90/100) | 95.0% (95/100) | +5.0 pp | 80% ✅ |')
  expect(body).toContain('https://github.com/owner/repo/commit/1234567890abc')
  expect(body).toContain('https://github.com/owner/repo/commit/abcdef0123456')
  expect(body).toContain('Updated in place by CI.')
})

test('coverage below the threshold fails and reports the decline', async () => {
  const { code, body } = await run('declined', report(70, 100), report(90, 100))
  expect(code).toBe(1)
  expect(body).toContain('❌ **70.0%**')
  expect(body).toContain('-20.0 pp')
  expect(body).toContain('80% ❌')
})

test('local runs without a baseline keep the plain coverage summary', async () => {
  const { code, body } = await run('local', report(90, 100))
  expect(code).toBe(0)
  expect(body).toContain('### Coverage\n')
  expect(body).not.toContain('Coverage impact')
})
