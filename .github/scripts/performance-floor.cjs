const fs = require('node:fs')
const path = require('node:path')

const { METHOD, NAME, SHA, validateMeta, validateReport } = require('./performance-report.cjs')

const VERSION = 1

function fail(message) {
  throw new Error(message)
}

function finite(value, label, minimum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)
    fail(`${label} must be a finite number >= ${minimum}`)
}

function emptyFloor() {
  return { version: VERSION, metrics: {} }
}

function validateFloor(value, label = 'floor') {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  if (value.version !== VERSION) fail(`${label}.version must be ${VERSION}`)
  if (value.metrics === null || typeof value.metrics !== 'object' || Array.isArray(value.metrics))
    fail(`${label}.metrics must be an object`)
  for (const [name, record] of Object.entries(value.metrics)) {
    if (!NAME.test(name)) fail(`${label}.metrics has an invalid metric name`)
    if (record === null || typeof record !== 'object' || Array.isArray(record))
      fail(`${label}.metrics.${name} must be an object`)
    if (typeof record.sha !== 'string' || !SHA.test(record.sha))
      fail(`${label}.metrics.${name}.sha must be a commit SHA`)
    // Records written before the method was tracked cannot be compared.
    if (record.method !== METHOD) continue
    finite(record.medianMs, `${label}.metrics.${name}.medianMs`, Number.EPSILON)
    finite(record.worstMedianMs, `${label}.metrics.${name}.worstMedianMs`, Number.EPSILON)
    if (record.worstMedianMs < record.medianMs)
      fail(`${label}.metrics.${name}.worstMedianMs must not be below its medianMs`)
    finite(record.budgetMs, `${label}.metrics.${name}.budgetMs`, Number.EPSILON)
    if (typeof record.updatedAt !== 'string' || !record.updatedAt)
      fail(`${label}.metrics.${name}.updatedAt must be a timestamp`)
  }
  return value
}

// Records from another timing method are dropped, so they are neither measured
// again nor used as a ceiling.
function readFloor(file) {
  if (!file || !fs.existsSync(file)) return emptyFloor()
  const floor = validateFloor(JSON.parse(fs.readFileSync(file, 'utf8')), file)
  const metrics = Object.fromEntries(
    Object.entries(floor.metrics).filter(([, record]) => record.method === METHOD)
  )
  return { version: VERSION, metrics }
}

function mapping(floor) {
  return Object.fromEntries(
    Object.entries(floor.metrics).map(([name, record]) => [name, record.sha])
  )
}

function budgets(floor) {
  return Object.fromEntries(
    Object.entries(floor.metrics).map(([name, record]) => [name, record.budgetMs])
  )
}

function variantShas({ floor, headSha, baseSha }) {
  const shas = new Set()
  if (baseSha) shas.add(baseSha)
  for (const sha of Object.values(mapping(floor))) shas.add(sha)
  shas.delete(headSha)
  return [...shas].sort()
}

function recordFor(result, sha, now, budgetMs) {
  return {
    sha,
    method: METHOD,
    medianMs: result.medianMs,
    worstMedianMs: result.worstMedianMs,
    budgetMs,
    updatedAt: now,
  }
}

// Ceilings are per workload. A record only moves when the new measurement's
// worst run beats the recorded best run, which keeps a noisy run from raising
// the ceiling. Budgets only tighten.
function updateFloor({ floor, meta, variants, now }) {
  const next = { version: VERSION, metrics: { ...floor.metrics } }
  const head = variants.get(meta.headSha)
  if (!head) fail(`No measurement for ${meta.headSha}`)
  if (head.method !== METHOD)
    fail(`The head measurement uses method ${head.method}, expected ${METHOD}.`)
  for (const result of head.results) {
    finite(result.worstMedianMs, `${result.name}.worstMedianMs`, Number.EPSILON)
    if (result.worstMedianMs < result.medianMs)
      fail(`${result.name}.worstMedianMs must not be below its medianMs`)
    finite(result.budgetMs, `${result.name}.budgetMs`, Number.EPSILON)
  }
  const measured = new Map(head.results.map((result) => [result.name, result]))
  const anchor = (sha, name) =>
    variants.get(sha)?.results.find((result) => result.name === name) ?? null
  const names = [...new Set([...Object.keys(next.metrics), ...measured.keys()])].sort()
  const changes = []
  for (const name of names) {
    const record = next.metrics[name] ?? null
    const current = measured.get(name) ?? null
    const measuredSha = meta.floor[name] ?? null
    if (record) {
      // Another run recorded a newer ceiling while this one was queued.
      if (measuredSha !== record.sha) continue
      if (!current) continue
      const before = anchor(record.sha, name)
      if (!before) continue
      const budgetMs =
        current.budgetMs > 0 ? Math.min(record.budgetMs, current.budgetMs) : record.budgetMs
      if (current.worstMedianMs >= before.medianMs) {
        if (budgetMs !== record.budgetMs) next.metrics[name] = { ...record, budgetMs }
        continue
      }
      next.metrics[name] = recordFor(current, meta.headSha, now, budgetMs)
      changes.push({ name, before: record.medianMs, after: current.medianMs })
      continue
    }
    // Every measured workload gets a ceiling, together with the budget it declared.
    if (current && measuredSha === null && current.budgetMs > 0) {
      next.metrics[name] = recordFor(current, meta.headSha, now, current.budgetMs)
      changes.push({ name, before: null, after: current.medianMs })
    }
  }
  return { floor: next, changes }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!key.startsWith('--')) fail(`Unknown argument ${key}`)
    args[key.slice(2)] = argv[index + 1]
  }
  return args
}

function readReport(file, label) {
  return validateReport(JSON.parse(fs.readFileSync(file, 'utf8')), label)
}

function runPlan(args) {
  if (!args.head || !SHA.test(args.head)) fail('--head must be a commit SHA')
  if (args.base && !SHA.test(args.base)) fail('--base must be a commit SHA')
  if (args.kind !== 'pull_request' && args.kind !== 'push')
    fail('--kind must be pull_request or push')
  if (!args.meta) fail('--meta is required')
  const floor = readFloor(args.floor)
  const meta = {
    kind: args.kind,
    headSha: args.head,
    baseSha: args.base || null,
    floor: mapping(floor),
    budgets: budgets(floor),
  }
  fs.writeFileSync(args.meta, `${JSON.stringify(meta, null, 2)}\n`)
  for (const sha of variantShas({ floor, headSha: meta.headSha, baseSha: meta.baseSha }))
    console.log(sha)
}

function runUpdate(args) {
  if (!args.meta || !args.dir || !args.out) fail('--meta, --dir, and --out are required')
  const meta = validateMeta(JSON.parse(fs.readFileSync(args.meta, 'utf8')), 'meta.json')
  if (meta.kind !== 'push') fail('Ceilings only update from a main run.')
  const floor = readFloor(args.floor)
  const variants = new Map()
  for (const sha of new Set([meta.headSha, ...Object.values(meta.floor)]))
    variants.set(sha, readReport(path.join(args.dir, `${sha}.json`), sha))
  const { floor: next, changes } = updateFloor({
    floor,
    meta,
    variants,
    now: args.now || new Date().toISOString(),
  })
  // Never commit a ceiling that the next run cannot read.
  validateFloor(next, args.out)
  fs.writeFileSync(args.out, `${JSON.stringify(next, null, 2)}\n`)
  if (args.marker)
    fs.writeFileSync(args.marker, `${changes.length > 0 ? 'changed' : 'unchanged'}\n`)
  if (changes.length === 0) {
    console.log('The ceiling is unchanged.')
    return
  }
  for (const change of changes)
    console.log(
      `${change.name}: ${change.before === null ? 'recorded' : 'lowered'} to ${change.after.toFixed(2)} ms`
    )
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (command === 'plan') return runPlan(args)
  if (command === 'update') return runUpdate(args)
  fail('Use plan or update.')
}

module.exports = {
  VERSION,
  budgets,
  emptyFloor,
  mapping,
  updateFloor,
  validateFloor,
  variantShas,
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
