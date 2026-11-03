// Check line coverage from a Cobertura report and print a markdown summary.

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const input = process.argv[2] ?? 'coverage/cobertura.xml'
const minimum = Number(process.argv[3] ?? process.env.COVERAGE_MIN ?? 80)
const output = process.argv[4] ?? 'coverage/comment.md'

const xml = await Bun.file(input).text()

const root = xml.match(/<coverage\b[^>]*>/)?.[0]
const attr = (name: string) => Number(root?.match(new RegExp(`${name}="([\\d.]+)"`))?.[1] ?? NaN)
const covered = attr('lines-covered')
const valid = attr('lines-valid')
if (!Number.isFinite(covered) || !Number.isFinite(valid) || valid === 0) {
  throw new Error(`${input} has no line coverage totals.`)
}

const percent = (covered / valid) * 100
const passed = percent >= minimum

const files = [...xml.matchAll(/<class name="[^"]+" filename="([^"]+)" line-rate="([\d.]+)"/g)]
  .map((match) => ({ filename: match[1], percent: Number(match[2]) * 100 }))
  .sort((a, b) => a.percent - b.percent || a.filename.localeCompare(b.filename))

const rows = files.map((file) => `| ${file.filename} | ${file.percent.toFixed(1)}% |`).join('\n')
const body = `<!-- coverage-report -->
### Coverage

**${percent.toFixed(1)}%** (${covered}/${valid} lines), ${passed ? 'meets' : 'is below'} the ${minimum}% threshold.

<details><summary>Files</summary>

| File | Lines |
| --- | --- |
${rows}

</details>
`

await mkdir(dirname(output), { recursive: true })
await Bun.write(output, body)

if (process.env.GITHUB_STEP_SUMMARY) {
  await Bun.write(process.env.GITHUB_STEP_SUMMARY, `${body}\n`, { createPath: true })
}

console.log(body)
process.exit(passed ? 0 : 1)
