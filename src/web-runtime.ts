import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import { pdfHtml } from './pdf/document'
import { pruneRuntimeCache, runtimeDirectory } from './runtime-cache'
import { runtimeErrorScript } from './runtime-errors'

const resources = {
  pdf: {
    'pdf.bundle.js': require('../dist/pdf.bundle.txt'),
    'pdf-worker.bundle.js': require('../dist/pdf-worker.bundle.txt'),
  },
  editor: {
    'editor.bundle.js': require('../dist/editor.bundle.txt'),
    'tree-sitter.wasm': require('web-tree-sitter/web-tree-sitter.wasm'),
    'typst-grammar.wasm': require('@lumis-sh/wasm-typst/tree-sitter-typst.wasm'),
    'editor-font.ttf': require('../assets/fonts/JetBrainsMono-Regular.ttf'),
  },
  compiler: {
    'compiler.bundle.js': require('../dist/compiler.bundle.txt'),
    'compiler-worker.bundle.js': require('../dist/compiler-worker.bundle.txt'),
    'compiler.wasm': require('../dist/compiler.wasm'),
    'editor-font.ttf': require('../assets/fonts/JetBrainsMono-Regular.ttf'),
    'serif-regular.otf': require('../assets/fonts/typst/LibertinusSerif-Regular.otf'),
    'serif-bold.otf': require('../assets/fonts/typst/LibertinusSerif-Bold.otf'),
    'serif-italic.otf': require('../assets/fonts/typst/LibertinusSerif-Italic.otf'),
    'math.otf': require('../assets/fonts/typst/NewCMMath-Regular.otf'),
  },
}
const pending = new Map<string, Promise<string>>()

export function afterPaint(callback: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(callback)
  })
  return () => cancelAnimationFrame(frame)
}

export function webRuntime(kind: keyof typeof resources): Promise<string> {
  const existing = pending.get(kind)
  if (existing) return existing
  const result = (async () => {
    if (!FileSystem.cacheDirectory) throw new Error('Private cache storage is unavailable.')
    // The compiler's wasm-bindgen bindings construct functions. The editor only needs WASM evaluation.
    const html =
      kind === 'pdf'
        ? pdfHtml()
        : `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' ${kind === 'compiler' ? "'unsafe-eval'" : "'wasm-unsafe-eval'"}; worker-src blob:; style-src 'unsafe-inline'; font-src 'self' file:; connect-src 'self' file:; img-src data:">
${kind === 'editor' ? '<link rel="preload" href="editor-font.ttf" as="font" type="font/ttf" crossorigin>' : ''}
<style>@font-face {font-family:'JetBrains Mono';src:url('editor-font.ttf')}html,body{margin:0;height:100%}#editor{height:100%}</style>
</head><body><div id="editor"></div><script>${runtimeErrorScript(kind === 'editor' ? 'Source editor' : 'PDF compiler')}</script><script src="${kind}.bundle.js"></script></body></html>`
    const assets = Object.entries(resources[kind]).map(([name, module]) => ({
      name,
      asset: Asset.fromModule(module),
    }))
    // A changed shell or bundle must never reuse the WebView's cached scripts.
    const directory = runtimeDirectory(
      FileSystem.cacheDirectory,
      kind,
      html,
      assets.map(({ name, asset }) => [name, asset.hash ?? asset.uri])
    )
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
    await Promise.all(
      assets.map(async ({ name, asset }) => {
        await asset.downloadAsync()
        if (!asset.localUri) throw new Error(`Cannot load bundled resource: ${name}`)
        await FileSystem.copyAsync({ from: asset.localUri, to: `${directory}${name}` })
      })
    )
    const uri = `${directory}${kind}.html`
    await FileSystem.writeAsStringAsync(uri, html)
    // Cache cleanup must not delay or prevent the runtime from starting.
    void pruneRuntimeCache(FileSystem.cacheDirectory, kind, directory, FileSystem).catch(() => {})
    return uri
  })().catch((error: unknown) => {
    pending.delete(kind)
    throw error
  })
  pending.set(kind, result)
  return result
}
