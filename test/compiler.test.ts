import { beforeAll, expect, test } from 'bun:test'
import { compilePdf, createCompiler, initializeCompiler } from '../src/compiler/engine'
import { packageKey, vaultPath } from '../src/compiler/protocol'
import { buildNoteSource, DEFAULT_TEMPLATE } from '../src/core'

const encode = (source: string) => new TextEncoder().encode(source)
let fonts: Uint8Array[]
beforeAll(async () => {
  await initializeCompiler(
    new Uint8Array(
      await Bun.file(
        'node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm'
      ).arrayBuffer()
    )
  )
  fonts = await Promise.all(
    [
      'assets/fonts/typst/LibertinusSerif-Regular.otf',
      'assets/fonts/typst/NewCMMath-Regular.otf',
    ].map(async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()))
  )
})

test('the bundled WASM compiler generates a real PDF without network access', async () => {
  const files = new Map([['/vault/main.typ', encode('= A mobile note\n\nÜber. Math: $x^2 + 1$.')]])
  const result = await compilePdf('main.typ', files, fonts, new Map())
  expect(result.missing).toEqual([])
  expect(result.diagnostics).toEqual([])
  expect(new TextDecoder().decode(result.pdf?.slice(0, 8))).toBe('%PDF-1.7')
  expect(result.pdf?.length).toBeGreaterThan(1000)
})

test('the default template compiles without vault styles or packages', async () => {
  const source = buildNoteSource('Plain title', 'Plain body.', DEFAULT_TEMPLATE)
  const result = await compilePdf(
    'plain.typ',
    new Map([['/vault/plain.typ', encode(source)]]),
    fonts,
    new Map()
  )
  expect(result.missing).toEqual([])
  expect(result.diagnostics).toEqual([])
  expect(result.pdf).toBeDefined()
})

test('nested notes can use shared root style resources without filesystem symlinks', async () => {
  const files = new Map([
    ['/vault/uni/main.typ', encode('#import "style/lib.typ": note-heading\n#note-heading[Hello]')],
    ['/vault/style/lib.typ', encode('#let note-heading(body) = heading(level: 1, body)')],
  ])
  const result = await compilePdf('uni/main.typ', files, fonts, new Map())
  expect(result.diagnostics).toEqual([])
  expect(result.pdf).toBeDefined()
  expect(result.dependencies).toContain('style/lib.typ')
  expect(result.dependencies).toContain('uni/style/lib.typ')
})

test('compile errors produce diagnostics and no PDF', async () => {
  const result = await compilePdf(
    'bad.typ',
    new Map([['/vault/bad.typ', encode('#unknown-function()')]]),
    fonts,
    new Map()
  )
  expect(result.pdf).toBeUndefined()
  expect(result.diagnostics.join('\n')).toContain('bad.typ, line 1, column 2')
  expect(result.diagnostics.join('\n')).toContain('unknown variable: unknown-function')
  expect(result.issues).toContainEqual(
    expect.objectContaining({
      path: 'bad.typ',
      line: 1,
      column: 2,
      severity: 'error',
      message: expect.stringContaining('unknown variable: unknown-function'),
    })
  )
})

test('compile errors point to the imported file that failed', async () => {
  const result = await compilePdf(
    'uni/note.typ',
    new Map([
      ['/vault/uni/note.typ', encode('#include "../style/lib.typ"')],
      ['/vault/style/lib.typ', encode('= Heading\n\n#missing')],
    ]),
    fonts,
    new Map()
  )
  expect(result.pdf).toBeUndefined()
  expect(result.diagnostics.join('\n')).toContain('style/lib.typ, line 3, column 2')
  expect(result.diagnostics.join('\n')).toContain('unknown variable: missing')
})

test('missing pinned packages are reported for the native cache to resolve', async () => {
  const result = await compilePdf(
    'main.typ',
    new Map([['/vault/main.typ', encode('#import "@preview/catppuccin:1.1.0": *')]]),
    fonts,
    new Map()
  )
  expect(result.pdf).toBeUndefined()
  expect(result.missing).toEqual([{ namespace: 'preview', name: 'catppuccin', version: '1.1.0' }])
})

test('portable local packages resolve from the vault', async () => {
  const files = new Map([
    ['/vault/main.typ', encode('#import "@local/test:1.0.0": title\n#title[Local]')],
    [
      '/vault/packages/local/test/1.0.0/typst.toml',
      encode('[package]\nname = "test"\nversion = "1.0.0"\nentrypoint = "lib.typ"'),
    ],
    ['/vault/packages/local/test/1.0.0/lib.typ', encode('#let title(body) = heading(body)')],
  ])
  const result = await compilePdf('main.typ', files, fonts, new Map())
  expect(result.missing).toEqual([])
  expect(result.diagnostics).toEqual([])
  expect(result.pdf).toBeDefined()
  expect(result.dependencies).toContain('packages/local/test/1.0.0/typst.toml')
  expect(result.dependencies).toContain('packages/local/test/1.0.0/lib.typ')
})

function archive(entries: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const [name, content] of Object.entries(entries)) {
    const data = encode(content)
    const header = new Uint8Array(512)
    header.set(encode(name), 0)
    header.set(encode('0000644\0'), 100)
    header.set(encode('0000000\0'), 108)
    header.set(encode('0000000\0'), 116)
    header.set(encode(`${data.length.toString(8).padStart(11, '0')}\0`), 124)
    header.set(encode('00000000000\0'), 136)
    header.fill(32, 148, 156)
    header[156] = 48
    header.set(encode('ustar\x00'), 257)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.set(encode(`${checksum.toString(8).padStart(6, '0')}\0 `), 148)
    chunks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512))
  }
  chunks.push(new Uint8Array(1024))
  const tar = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    tar.set(chunk, offset)
    offset += chunk.length
  }
  return Bun.gzipSync(tar)
}

test('cached package archives resolve offline through the WASM registry', async () => {
  const files = new Map([
    ['/vault/main.typ', encode('#import "@preview/test:1.0.0": title\n#title[Cached]')],
  ])
  const packages = new Map([
    [
      'preview/test/1.0.0',
      archive({
        'typst.toml': '[package]\nname = "test"\nversion = "1.0.0"\nentrypoint = "lib.typ"',
        'lib.typ': '#let title(body) = heading(body)',
      }),
    ],
  ])
  const result = await compilePdf('main.typ', files, fonts, packages)
  expect(result.missing).toEqual([])
  expect(result.diagnostics).toEqual([])
  expect(result.pdf).toBeDefined()
})

test('a warm compiler reuses fonts while rereading changed sources and dependencies', async () => {
  const files = new Map([
    ['/vault/one.typ', encode('#include "shared.typ"')],
    ['/vault/two.typ', encode('= Second note')],
    ['/vault/shared.typ', encode('First body')],
  ])
  const compiler = await createCompiler(files, fonts, new Map())
  try {
    const first = compiler.compile('one.typ')
    expect(first.pdf).toBeDefined()
    expect(first.dependencies).toContain('shared.typ')
    expect(compiler.compile('two.typ').pdf).toBeDefined()
    files.set('/vault/shared.typ', encode('#unknown-function()'))
    const failed = compiler.compile('one.typ')
    expect(failed.pdf).toBeUndefined()
    expect(failed.diagnostics.join('\n')).toContain('unknown')
    files.set('/vault/shared.typ', encode('Fixed body'))
    const fixed = compiler.compile('one.typ')
    expect(fixed.pdf).toBeDefined()
    expect(fixed.dependencies).toContain('shared.typ')
  } finally {
    compiler.dispose()
  }
})

test('a warm compiler retries missing packages after their archives arrive', async () => {
  const files = new Map([
    ['/vault/main.typ', encode('#import "@preview/test:1.0.0": title\n#title[Cached]')],
  ])
  const archives = new Map<string, Uint8Array>()
  const compiler = await createCompiler(files, fonts, archives)
  try {
    expect(compiler.compile('main.typ').missing).toHaveLength(1)
    archives.set(
      'preview/test/1.0.0',
      archive({
        'typst.toml': '[package]\nname = "test"\nversion = "1.0.0"\nentrypoint = "lib.typ"',
        'lib.typ': '#let title(body) = heading(body)',
      })
    )
    const result = compiler.compile('main.typ')
    expect(result.missing).toEqual([])
    expect(result.pdf).toBeDefined()
    expect(compiler.compile('main.typ').pdf).toBeDefined()
  } finally {
    compiler.dispose()
  }
})

test('compiler paths and package names cannot escape their roots', () => {
  expect(vaultPath('uni/note.typ')).toBe('/vault/uni/note.typ')
  for (const path of ['../private.txt', '/etc/passwd', 'a/../b.typ', 'a\\b.typ', 'a\u0000.typ'])
    expect(() => vaultPath(path)).toThrow()
  expect(packageKey({ namespace: 'preview', name: 'catppuccin', version: '1.1.0' })).toBe(
    'preview/catppuccin/1.1.0'
  )
  expect(() =>
    packageKey({ namespace: 'preview', name: '../../secret', version: '1.0.0' })
  ).toThrow()
})
