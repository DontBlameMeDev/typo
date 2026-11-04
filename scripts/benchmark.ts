import { createCompiler, initializeCompiler } from '../src/compiler/engine'
import { PdfWorkspace } from '../src/compiler/workspace'
import { createNoteSearch } from '../src/core'
import { TypstSyntax, typstLanguage } from '../src/editor/syntax'
import type { Note } from '../src/types'

export type Measurement = {
  name: string
  samples: number
  medianMs: number
  p95Ms: number
  maxTimerGapMs: number
}

export async function runBenchmarks(read: (path: string) => Promise<Uint8Array>) {
  const results: Measurement[] = []
  async function measure(name: string, run: () => unknown, samples = 15, warmup = 3) {
    for (let i = 0; i < warmup; i++) await run()
    const times: number[] = []
    let maxTimerGapMs = 0
    for (let i = 0; i < samples; i++) {
      let tick = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        maxTimerGapMs = Math.max(maxTimerGapMs, now - tick)
        tick = now
      }, 1)
      try {
        const start = performance.now()
        await run()
        times.push(performance.now() - start)
        await new Promise((resolve) => setTimeout(resolve, 5))
      } finally {
        clearInterval(timer)
      }
    }
    times.sort((a, b) => a - b)
    const result = {
      name,
      samples,
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.ceil(times.length * 0.95) - 1],
      maxTimerGapMs,
    }
    results.push(result)
    console.info(JSON.stringify(result))
  }
  for (const count of [100, 1000]) {
    const notes: Note[] = Array.from({ length: count }, (_, i) => ({
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
    await measure(
      `search/${count}/first-content`,
      async () => {
        const result = await createNoteSearch(notes)('probability', 'all')
        if (result.length !== count) throw new Error('Incomplete search results')
      },
      5,
      0
    )
    const search = createNoteSearch(notes)
    for (const [label, query, mode] of [
      ['names', 'lec42', 'names'],
      ['literal', 'probability', 'all'],
      ['fuzzy', 'unmt', 'all'],
      ['missing', 'zzq', 'all'],
    ] as const)
      await measure(`search/${count}/${label}`, () => search(query, mode))
  }
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
      `syntax/${lines}/open`,
      () => {
        const syntax = new TypstSyntax(language)
        try {
          syntax.highlights(original, { from: 0, to: 1000 })
        } finally {
          syntax.destroy()
        }
      },
      5,
      1
    )
    const syntax = new TypstSyntax(language)
    try {
      syntax.highlights(original, { from: 0, to: 1000 })
      await measure(`syntax/${lines}/scroll`, () =>
        syntax.highlights(original, { from: original.length - 1000, to: original.length })
      )
      let source = original
      await measure(`syntax/${lines}/type-at-end`, () => {
        source += 'x'
        syntax.highlights(source, { from: source.length - 1000, to: source.length })
      })
    } finally {
      syntax.destroy()
    }
  }
  await measure(
    'compiler/initialize',
    async () => {
      await initializeCompiler(
        await read(
          'node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm'
        )
      )
    },
    1,
    0
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
      `compiler/${pages}-pages/cold`,
      async () => {
        const compiler = await createCompiler(files, fonts, new Map())
        try {
          if (!compiler.compile('main.typ').pdf) throw new Error('Compilation failed')
        } finally {
          compiler.dispose()
        }
      },
      5,
      1
    )
    const compiler = await createCompiler(files, fonts, new Map())
    try {
      await measure(
        `compiler/${pages}-pages/warm`,
        () => {
          if (!compiler.compile('main.typ').pdf) throw new Error('Compilation failed')
        },
        10
      )
    } finally {
      compiler.dispose()
    }
  }
  const workspace = new PdfWorkspace({
    readFiles: async () =>
      Array.from({ length: 1000 }, (_, i) => ({
        path: `note_${i}.typ`,
        base64: 'YWJj'.repeat(32),
      })),
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
    },
  })
  try {
    await measure('workspace/1000-files/refresh', () => workspace.refresh(), 5, 1)
  } finally {
    workspace.dispose()
  }
  return results
}

async function main() {
  const { cpus, platform, release } = await import('node:os')
  const results = await runBenchmarks(
    async (path) => new Uint8Array(await Bun.file(path).arrayBuffer())
  )
  console.log(
    JSON.stringify(
      {
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
