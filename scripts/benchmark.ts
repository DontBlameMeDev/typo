import { createCompiler, initializeCompiler } from '../src/compiler/engine'
import { fingerprint } from '../src/compiler/fingerprint'
import { PdfWorkspace } from '../src/compiler/workspace'
import { createNoteSearch, foldersFromNotes } from '../src/core'
import { applyEditorChange, editorMessage } from '../src/editor/protocol'
import { TypstSyntax, typstLanguage } from '../src/editor/syntax'
import { parseVaultIndex, serializeVaultIndex } from '../src/library-index'
import { sortedNoteRows } from '../src/library-rows'
import type { Note } from '../src/types'

// Measurements are only comparable within one method. Changing how a workload is
// timed invalidates the recorded ceilings.
export const METHOD = 2

export type Measurement = {
  name: string
  criterion: string
  budgetMs: number
  samples: number
  repeat: number
  medianMs: number
  p95Ms: number
  // Operation time at the 99th percentile, which is the maximum when a workload
  // runs a handful of times. Timed per operation instead of sampled with a timer,
  // so one scheduler stall in a batched workload cannot reach the ceiling gate.
  maxTimerGapMs: number
}

const FRAME_MS = 16.7
const TWO_FRAMES_MS = 33.4

function notesFor(count: number): Note[] {
  return Array.from({ length: count }, (_, i) => ({
    uri: `content://${i}`,
    path: `folder_${i % 20}/note_${i}.typ`,
    title: `Lecture ${i} mathematics`,
    source:
      `#title[Lecture ${i}]\n` +
      Array.from(
        { length: 100 },
        (_, j) =>
          `Paragraph ${j}: Understanding algebra, probability and the mathematics of physical systems ${i}.`
      ).join('\n'),
    modifiedAt: 1,
  }))
}

type Workload = {
  name: string
  criterion: string
  budgetMs: number
  // Repetitions per sample. Cheap operations repeat so one sample accumulates
  // enough work to time reliably.
  repeat?: number
  samples?: number
  warmup?: number
}

export async function runBenchmarks(read: (path: string) => Promise<Uint8Array>, quiet = false) {
  const results: Measurement[] = []
  async function measure(workload: Workload, run: () => unknown) {
    const { name, criterion, budgetMs, repeat = 1, samples = 15 } = workload
    // Warm up for a whole sample so the JIT has optimized the hot path before the
    // samples are timed. Otherwise the first round is the slow one and its spread
    // loosens the ceiling comparison.
    for (let i = 0; i < (workload.warmup ?? (repeat > 1 ? repeat : 3)); i++) await run()
    const times: number[] = []
    for (let sample = 0; sample < samples; sample++) {
      for (let iteration = 0; iteration < repeat; iteration++) {
        const start = performance.now()
        await run()
        times.push(performance.now() - start)
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    times.sort((a, b) => a - b)
    const percentile = (fraction: number) =>
      times[Math.min(times.length - 1, Math.ceil(times.length * fraction) - 1)]
    const result: Measurement = {
      name,
      criterion,
      budgetMs,
      samples,
      repeat,
      medianMs: percentile(0.5),
      p95Ms: percentile(0.95),
      maxTimerGapMs: percentile(0.99),
    }
    results.push(result)
    if (!quiet) console.info(JSON.stringify(result))
  }
  const searchRepeats: Record<number, Record<string, number>> = {
    100: { names: 100, literal: 30, fuzzy: 20, missing: 40 },
    1000: { names: 20, literal: 5, fuzzy: 2, missing: 5 },
  }
  for (const count of [100, 1000]) {
    const notes = notesFor(count)
    await measure(
      {
        name: `search/${count}/first-content`,
        criterion: 'first search after launch builds the index',
        budgetMs: count === 100 ? FRAME_MS : 100,
        samples: 10,
        warmup: 1,
      },
      async () => {
        const result = await createNoteSearch(notes)('probability', 'all')
        if (result.length !== count) throw new Error('Incomplete search results')
      }
    )
    const search = createNoteSearch(notes)
    for (const [label, query, mode] of [
      ['names', 'lec42', 'names'],
      ['literal', 'probability', 'all'],
      ['fuzzy', 'unmt', 'all'],
      ['missing', 'zzq', 'all'],
    ] as const)
      await measure(
        {
          name: `search/${count}/${label}`,
          criterion:
            count === 100 ? 'search-as-you-type within one frame' : 'search within two frames',
          budgetMs: count === 100 ? FRAME_MS : TWO_FRAMES_MS,
          repeat: searchRepeats[count][label],
        },
        () => search(query, mode)
      )
  }
  let incrementalNotes = notesFor(1000)
  const incremental = createNoteSearch(incrementalNotes)
  await incremental('probability', 'content')
  let edit = 0
  await measure(
    {
      name: 'search/1000/reindex',
      criterion: '64 edited notes reindex within two frames',
      budgetMs: TWO_FRAMES_MS,
      samples: 5,
      warmup: 1,
    },
    () => {
      for (let i = 0; i < 64; i++) {
        incrementalNotes = incrementalNotes.map((note, index) =>
          index === 0 ? { ...note, source: `${note.source}\nEdited ${++edit}` } : note
        )
        incremental.update(incrementalNotes)
      }
    }
  )
  await measure(
    {
      name: 'search/1000/update-content',
      criterion: 'index a typed edit and query within two frames',
      budgetMs: TWO_FRAMES_MS,
      repeat: 2,
      samples: 5,
      warmup: 1,
    },
    async () => {
      incrementalNotes = incrementalNotes.map((note, index) =>
        index === 0 ? { ...note, source: `${note.source}\nEdited ${++edit}` } : note
      )
      for (let i = 0; i < 3; i++) {
        incrementalNotes = incrementalNotes.map((note, index) =>
          index === 0 ? { ...note, source: `${note.source}\nEdited ${++edit}` } : note
        )
        incremental.update(incrementalNotes)
        const result = await incremental('probability', 'all')
        if (result.length !== 1000) throw new Error('Incomplete search results')
      }
    }
  )
  // The first library frame after launch: parsing the cached index and building
  // the root rows. Native reads are outside this measurement, so a regression
  // here is JS work that blocks the first paint on every device.
  for (const count of [100, 1000]) {
    const vault = {
      uri: 'content://com.android.externalstorage.documents/tree/primary%3APerf',
      name: 'Perf',
    }
    const cached = serializeVaultIndex(
      vault,
      notesFor(count).map((note) => ({
        ...note,
        uri: `${vault.uri}/document/${encodeURIComponent(note.path)}`,
      }))
    )
    await measure(
      {
        name: `startup/${count}/first-rows`,
        criterion:
          count === 100
            ? 'cached library rows ready within one frame'
            : 'cached library rows ready within two frames',
        budgetMs: count === 100 ? FRAME_MS : TWO_FRAMES_MS,
        samples: 10,
        warmup: 1,
      },
      () => {
        const notes = parseVaultIndex(cached, vault)
        if (!notes || notes.length !== count) throw new Error('Invalid cached index')
        foldersFromNotes(notes)
        const rows = sortedNoteRows(new Map(), '', notes, 'name-asc')
        if (rows.length !== count) throw new Error('Incomplete library rows')
      }
    )
  }
  const editorBase = Array.from(
    { length: 10000 },
    (_, i) => `#let value${i} = ${i} // A comment`
  ).join('\n')
  await measure(
    {
      name: 'editor/10000/change',
      criterion: '30,000 editor changes within two frames',
      budgetMs: TWO_FRAMES_MS,
      repeat: 2,
      samples: 5,
      warmup: 1,
    },
    () => {
      let source = editorBase
      const change = { from: source.length, to: source.length, insert: 'x' }
      for (let i = 0; i < 30000; i++) {
        const message = editorMessage(
          JSON.stringify({ type: 'change', documentId: 'note:1', session: 1, change }),
          'note:1'
        )
        if (message?.type !== 'change') throw new Error('Invalid editor change')
        source = applyEditorChange(source, message.change)
        change.from = source.length
        change.to = source.length
      }
    }
  )
  const language = await typstLanguage(
    await read('node_modules/web-tree-sitter/web-tree-sitter.wasm'),
    await read('node_modules/@lumis-sh/wasm-typst/tree-sitter-typst.wasm')
  )
  for (const lines of [1000, 10000]) {
    const original = Array.from(
      { length: lines },
      (_, i) => `#let value${i} = ${i} // A comment`
    ).join('\n')
    await measure(
      {
        name: `syntax/${lines}/open`,
        criterion: lines === 1000 ? 'highlight an opened note' : 'highlight a huge note',
        budgetMs: lines === 1000 ? TWO_FRAMES_MS : 100,
        repeat: lines === 1000 ? 2 : 1,
        samples: 5,
        warmup: 1,
      },
      () => {
        const syntax = new TypstSyntax(language)
        try {
          syntax.highlights(original, { from: 0, to: 1000 })
        } finally {
          syntax.destroy()
        }
      }
    )
    const syntax = new TypstSyntax(language)
    try {
      syntax.highlights(original, { from: 0, to: 1000 })
      await measure(
        {
          name: `syntax/${lines}/scroll`,
          criterion: 'highlight a scrolled window within one frame',
          budgetMs: FRAME_MS,
          repeat: 50,
        },
        () => syntax.highlights(original, { from: original.length - 1000, to: original.length })
      )
      let source = original
      await measure(
        {
          name: `syntax/${lines}/type-at-end`,
          criterion:
            lines === 1000
              ? 'highlight a keystroke within one frame'
              : 'highlight a keystroke on a huge note within three frames',
          budgetMs: lines === 1000 ? FRAME_MS : 50,
          repeat: lines === 1000 ? 10 : 1,
        },
        () => {
          source += 'x'
          syntax.highlights(source, { from: source.length - 1000, to: source.length })
        }
      )
    } finally {
      syntax.destroy()
    }
  }
  await measure(
    {
      name: 'compiler/initialize',
      criterion: 'compiler startup within 400 ms',
      budgetMs: 400,
      // Only the first call initializes the module, so it is measured once.
      samples: 1,
      warmup: 0,
    },
    async () => {
      await initializeCompiler(
        await read(
          'node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm'
        )
      )
    }
  )
  const fonts = await Promise.all(
    ['LibertinusSerif-Regular.otf', 'NewCMMath-Regular.otf'].map((name) =>
      read(`assets/fonts/typst/${name}`)
    )
  )
  const files = new Map<string, Uint8Array>()
  const encode = (value: string) => new TextEncoder().encode(value)
  for (const pages of [1, 20]) {
    files.set(
      '/vault/main.typ',
      encode(
        Array.from(
          { length: pages },
          (_, i) =>
            `= Page ${i + 1}\n\nÜber. Math: $x^2 + 1$.\n${'A short paragraph. '.repeat(100)}`
        ).join('\n#pagebreak()\n')
      )
    )
    await measure(
      {
        name: `compiler/${pages}-pages/cold`,
        criterion: 'cold compile within 100 ms',
        budgetMs: 100,
        repeat: pages === 1 ? 4 : 2,
        samples: 5,
        warmup: 1,
      },
      async () => {
        const compiler = await createCompiler(files, fonts, new Map())
        try {
          if (!compiler.compile('main.typ').pdf) throw new Error('Compilation failed')
        } finally {
          compiler.dispose()
        }
      }
    )
    const compiler = await createCompiler(files, fonts, new Map())
    try {
      await measure(
        {
          name: `compiler/${pages}-pages/warm`,
          criterion:
            pages === 1 ? 'warm recompile within one frame' : 'warm recompile within two frames',
          budgetMs: pages === 1 ? FRAME_MS : TWO_FRAMES_MS,
          repeat: pages === 1 ? 15 : 2,
          samples: 10,
        },
        () => {
          if (!compiler.compile('main.typ').pdf) throw new Error('Compilation failed')
        }
      )
    } finally {
      compiler.dispose()
    }
  }
  const hashed = Array.from({ length: 1000 }, (_, index) => btoa(`${index}:${'abc'.repeat(3200)}`))
  await measure(
    {
      name: 'fingerprint/12mb',
      criterion: 'hash a full vault fingerprint within three frames',
      budgetMs: 50,
      samples: 5,
      warmup: 1,
    },
    () => {
      for (const value of hashed) fingerprint(value)
    }
  )
  let revision = 0
  const body = 'abc'.repeat(3200)
  const workspace = new PdfWorkspace({
    readFiles: async () => {
      const base64 = btoa(`${revision}:${body}`)
      return Array.from({ length: 1000 }, (_, i) => ({ path: `note_${i}.typ`, base64 }))
    },
    compile: async () => {
      throw new Error('No notes should compile')
    },
    storage: {
      read: async () => null,
      save: async () => {},
      cache: async () => '',
      base64: async () => '',
      stamp: async () => null,
      write: async () => '',
      hash: async () => {},
    },
  })
  try {
    await measure(
      {
        name: 'workspace/1000-files/unchanged-refresh',
        criterion: 'refresh an unchanged vault within one frame',
        budgetMs: FRAME_MS,
        repeat: 10,
        samples: 5,
        warmup: 1,
      },
      () => workspace.refresh()
    )
    await measure(
      {
        name: 'workspace/1000-files/changed-refresh',
        criterion: 'refresh a changed vault within 100 ms',
        budgetMs: 100,
        samples: 5,
        warmup: 1,
      },
      () => {
        revision++
        return workspace.refresh()
      }
    )
  } finally {
    workspace.dispose()
  }
  return results
}

async function main() {
  const { cpus, platform, release } = await import('node:os')
  const results = await runBenchmarks(
    async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
    process.argv.includes('--json')
  )
  console.log(
    JSON.stringify(
      {
        method: METHOD,
        runtime: `Bun ${Bun.version}`,
        os: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        results,
      },
      null,
      2
    )
  )
}

if (import.meta.main) void main()
