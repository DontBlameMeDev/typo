import { beforeAll, expect, test } from 'bun:test'
import { compilePdf, initializeCompiler } from '../src/compiler/engine'
import { packageKey, vaultPath } from '../src/compiler/protocol'
import { BUILTIN_TEMPLATES, buildNoteSource } from '../src/core'

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

test('the built-in template compiles without vault styles or packages', async () => {
  const source = buildNoteSource('Plain title', 'Plain body.', BUILTIN_TEMPLATES[0].source)
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
})

test('compile errors produce diagnostics and no PDF', async () => {
  const result = await compilePdf(
    'bad.typ',
    new Map([['/vault/bad.typ', encode('#unknown-function()')]]),
    fonts,
    new Map()
  )
  expect(result.pdf).toBeUndefined()
  expect(result.diagnostics.join('\n')).toContain('unknown')
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
