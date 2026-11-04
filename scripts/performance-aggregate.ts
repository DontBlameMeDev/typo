// Combine repeated benchmark runs into one best-case artifact per variant.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const directory = process.argv[2] ?? 'performance'
const baseSha = process.argv[3] ?? 'unknown'
const prSha = process.argv[4] ?? 'unknown'
const runs = Number(process.argv[5] ?? 3)

type Result = {
  name: string
  samples: number
  medianMs: number
  p95Ms: number
  maxTimerGapMs: number
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
  const results = first.results.map(({ name, samples }) => {
    const values = reports.map((report) => {
      const result = report.results.find((entry) => entry.name === name)
      if (!result) throw new Error(`A run is missing metric ${name}.`)
      return result
    })
    return {
      name,
      samples,
      medianMs: Math.min(...values.map((value) => value.medianMs)),
      p95Ms: Math.min(...values.map((value) => value.p95Ms)),
      maxTimerGapMs: Math.min(...values.map((value) => value.maxTimerGapMs)),
    }
  })
  return { runtime: first.runtime, os: first.os, cpu: first.cpu, results }
}

async function variant(prefix: string) {
  const reports: Report[] = []
  for (let index = 1; index <= runs; index++)
    reports.push(await read(join(directory, `${prefix}-${index}.json`)))
  try {
    return best(reports)
  } catch (error) {
    throw new Error(`${prefix} runs do not share the same metrics: ${String(error)}`)
  }
}

const [base, pr] = await Promise.all([variant('base'), variant('pr')])
await mkdir(directory, { recursive: true })
await Bun.write(join(directory, 'base.json'), JSON.stringify(base))
await Bun.write(join(directory, 'pr.json'), JSON.stringify(pr))
await Bun.write(join(directory, 'meta.json'), JSON.stringify({ baseSha, prSha }))
console.log(`Wrote best of ${runs} runs for ${base.results.length} metrics.`)
