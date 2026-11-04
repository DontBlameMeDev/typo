// Check line coverage from a Cobertura report and print a markdown summary.

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const input = process.argv[2] ?? 'coverage/cobertura.xml'
const minimum = Number(process.argv[3] ?? process.env.COVERAGE_MIN ?? 80)
const output = process.argv[4] ?? 'coverage/comment.md'

type Totals = { covered: number; valid: number; percent: number }

async function totals(path: string): Promise<Totals> {
  const root = (await Bun.file(path).text()).match(/<coverage\b[^>]*>/)?.[0]
  const attr = (name: string) => Number(root?.match(new RegExp(`${name}="([\\d.]+)"`))?.[1] ?? NaN)
  const covered = attr('lines-covered')
  const valid = attr('lines-valid')
  if (!Number.isFinite(covered) || !Number.isFinite(valid) || valid === 0) {
    throw new Error(`${path} has no line coverage totals.`)
  }
  return { covered, valid, percent: (covered / valid) * 100 }
}

const count = (value: number) => value.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',')

const current = await totals(input)
const passed = current.percent >= minimum
const baseline = process.env.BASELINE_COVERAGE ? await totals(process.env.BASELINE_COVERAGE) : null

const xml = await Bun.file(input).text()
const files = [...xml.matchAll(/<class name="[^"]+" filename="([^"]+)" line-rate="([\d.]+)"/g)]
  .map((match) => ({ filename: match[1], percent: Number(match[2]) * 100 }))
  .sort((a, b) => a.percent - b.percent || a.filename.localeCompare(b.filename))

const rows = files.map((file) => `| ${file.filename} | ${file.percent.toFixed(1)}% |`).join('\n')
const details = `<details><summary>Files</summary>

| File | Lines |
| --- | --- |
${rows}

</details>`

const repository = process.env.GITHUB_REPOSITORY
const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
const commit = (sha: string | undefined) => {
  if (!sha) return ''
  const short = sha.slice(0, 7)
  return repository ? `[\`${short}\`](${server}/${repository}/commit/${sha})` : `\`${short}\``
}
const baselineSha = commit(process.env.BASELINE_SHA)
const headSha = commit(process.env.HEAD_SHA)
const source = [
  baselineSha && `Baseline: ${baselineSha}`,
  headSha && `PR result: ${headSha}`,
].filter(Boolean)

const delta = baseline ? current.percent - baseline.percent : 0
const impact = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pp`
const status = passed ? '✅' : '❌'
const summary = baseline
  ? `### Coverage impact

${status} **${current.percent.toFixed(1)}%** of ${count(current.valid)} instrumented lines are covered, ${passed ? 'above' : 'below'} the ${minimum}% threshold.

| Scope | Main baseline | This PR | Impact | Threshold |
| :---- | ------------: | ------: | -----: | --------: |
| Lines | ${baseline.percent.toFixed(1)}% (${count(baseline.covered)}/${count(baseline.valid)}) | ${current.percent.toFixed(1)}% (${count(current.covered)}/${count(current.valid)}) | ${impact} | ${minimum}% ${status} |

${source.length ? `${source.join(' · ')}\n\n` : ''}${details}

Updated in place by CI. The baseline is measured from \`main\`; this PR is measured from its head commit.`
  : `### Coverage

**${current.percent.toFixed(1)}%** (${current.covered}/${current.valid} lines), ${passed ? 'meets' : 'is below'} the ${minimum}% threshold.

Files that no test imports are not part of the report.

${details}`

const body = `<!-- coverage-report -->
${summary}
`

await mkdir(dirname(output), { recursive: true })
await Bun.write(output, body)

if (process.env.GITHUB_STEP_SUMMARY) {
  await Bun.write(process.env.GITHUB_STEP_SUMMARY, `${body}\n`, { createPath: true })
}

console.log(body)
process.exit(passed ? 0 : 1)
