// Combine repeated benchmark runs into one best-case artifact per commit.

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const input = process.argv[2] ?? 'performance/raw'
const output = process.argv[3] ?? 'performance'
const rounds = Number(process.argv[4] ?? 3)
const RUN = /^([0-9a-f]{40})-(\d+)\.json$/u

type Result = {
  name: string
  samples: number
  medianMs: number
  worstMedianMs: number
  p95Ms: number
  maxTimerGapMs: number
  noisePercent: number
}
type Report = { runtime: string; os: string; cpu: string; results: Result[] }

async function read(path: string): Promise<Report> {
  const report = (await Bun.file(path).json()) as Report
  if (!Array.isArray(report.results) || report.results.length === 0)
    throw new Error(`${path} has no results.`)
  return report
}

function best(reports: Report[]): Report {
  const first = reports[0]
  const expected = first.results.map((result) => result.name).sort()
  for (const report of reports) {
    const actual = report.results.map((result) => result.name).sort()
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
      throw new Error('runs do not share the same metric set')
  }
  const results = first.results.map(({ name, samples }) => {
    const values = reports.map((report) => {
      const result = report.results.find((entry) => entry.name === name)
      if (!result) throw new Error(`A run is missing metric ${name}.`)
      return result
    })
    const medians = values.map((value) => value.medianMs)
    const best = Math.min(...medians)
    const worst = Math.max(...medians)
    return {
      name,
      samples,
      medianMs: best,
      worstMedianMs: worst,
      p95Ms: Math.min(...values.map((value) => value.p95Ms)),
      maxTimerGapMs: Math.min(...values.map((value) => value.maxTimerGapMs)),
      noisePercent: (worst / best - 1) * 100,
    }
  })
  return { runtime: first.runtime, os: first.os, cpu: first.cpu, results }
}

const variants = new Map<string, Map<number, string>>()
for (const file of await readdir(input)) {
  const match = RUN.exec(file)
  if (!match) continue
  const round = Number(match[2])
  if (!Number.isSafeInteger(round) || round < 1 || round > rounds)
    throw new Error(`${file} has a round outside 1..${rounds}.`)
  const runs = variants.get(match[1]) ?? new Map<number, string>()
  runs.set(round, join(input, file))
  variants.set(match[1], runs)
}
if (variants.size === 0) throw new Error(`No benchmark runs found in ${input}.`)
await mkdir(output, { recursive: true })
for (const [sha, runs] of variants) {
  if (runs.size !== rounds) throw new Error(`${sha} has ${runs.size} of ${rounds} runs.`)
  const reports: Report[] = []
  for (let round = 1; round <= rounds; round++) {
    const file = runs.get(round)
    if (!file) throw new Error(`${sha} has no run ${round}.`)
    reports.push(await read(file))
  }
  let combined: Report
  try {
    combined = best(reports)
  } catch (error) {
    throw new Error(`${sha} runs do not share the same metrics: ${String(error)}`)
  }
  await writeFile(join(output, `${sha}.json`), JSON.stringify(combined))
}
console.log(`Wrote best of ${rounds} runs for ${variants.size} commits.`)
