// Convert Bun's lcov report to the Cobertura XML that GitHub code coverage reads.

import { mkdir } from 'node:fs/promises'
import { dirname, relative } from 'node:path'

const input = process.argv[2] ?? 'coverage/lcov.info'
const output = process.argv[3] ?? 'coverage/cobertura.xml'

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

function parseFile(block: string) {
  let filename = ''
  const lines: { number: number; hits: number }[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('SF:')) filename = line.slice(3).trim()
    else if (line.startsWith('DA:')) {
      const [number, hits] = line.slice(3).split(',')
      lines.push({ number: Number(number), hits: Number(hits) })
    }
  }
  if (!filename) return null
  return { filename: relative(process.cwd(), filename), lines }
}

const records = (await Bun.file(input).text()).split('end_of_record')
const files = records.map(parseFile).filter((file) => file !== null)
if (files.length === 0) throw new Error(`${input} has no coverage records.`)

const lineRate = (lines: { hits: number }[]) =>
  lines.length === 0 ? 0 : lines.filter((line) => line.hits > 0).length / lines.length

const totalLines = files.flatMap((file) => file.lines)
const covered = totalLines.filter((line) => line.hits > 0).length

const packages = new Map<string, typeof files>()
for (const file of files) {
  const dir = dirname(file.filename)
  packages.set(dir, [...(packages.get(dir) ?? []), file])
}

const packageXml = [...packages]
  .map(([dir, packageFiles]) => {
    const classes = packageFiles
      .map((file) => {
        const rate = lineRate(file.lines).toFixed(4)
        const lines = file.lines
          .sort((a, b) => a.number - b.number)
          .map((line) => `            <line number="${line.number}" hits="${line.hits}"/>`)
          .join('\n')
        return `        <class name="${escapeXml(file.filename)}" filename="${escapeXml(file.filename)}" line-rate="${rate}" branch-rate="0" complexity="0">
          <methods/>
          <lines>
${lines}
          </lines>
        </class>`
      })
      .join('\n')
    const rate = lineRate(packageFiles.flatMap((file) => file.lines)).toFixed(4)
    return `    <package name="${escapeXml(dir)}" line-rate="${rate}" branch-rate="0" complexity="0">
      <classes>
${classes}
      </classes>
    </package>`
  })
  .join('\n')

const xml = `<?xml version="1.0" ?>
<coverage line-rate="${(covered / totalLines.length).toFixed(4)}" branch-rate="0" lines-covered="${covered}" lines-valid="${totalLines.length}" branches-covered="0" branches-valid="0" complexity="0" version="0.1" timestamp="${Date.now()}">
  <sources>
    <source>.</source>
  </sources>
  <packages>
${packageXml}
  </packages>
</coverage>
`

await mkdir(dirname(output), { recursive: true })
await Bun.write(output, xml)
console.log(`Wrote ${output}: ${covered}/${totalLines.length} lines covered.`)
