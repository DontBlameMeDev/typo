import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import { pdfHtml } from './pdf/document'

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
    'compiler.wasm': require('@myriaddreamin/typst-ts-web-compiler/wasm'),
    'editor-font.ttf': require('../assets/fonts/JetBrainsMono-Regular.ttf'),
    'serif-regular.otf': require('../assets/fonts/typst/LibertinusSerif-Regular.otf'),
    'serif-bold.otf': require('../assets/fonts/typst/LibertinusSerif-Bold.otf'),
    'serif-italic.otf': require('../assets/fonts/typst/LibertinusSerif-Italic.otf'),
    'math.otf': require('../assets/fonts/typst/NewCMMath-Regular.otf'),
  },
}
const pending = new Map<string, Promise<string>>()
const installed = new Map<string, Promise<void>>()

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
    const directory = `${FileSystem.cacheDirectory}typo-runtime/`
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
    await Promise.all(
      Object.entries(resources[kind]).map(async ([name, module]) => {
        let copy = installed.get(name)
        if (!copy) {
          copy = (async () => {
            const asset = await Asset.fromModule(module).downloadAsync()
            if (!asset.localUri) throw new Error(`Cannot load bundled resource: ${name}`)
            await FileSystem.copyAsync({ from: asset.localUri, to: `${directory}${name}` })
          })().catch((cause: unknown) => {
            installed.delete(name)
            throw cause
          })
          installed.set(name, copy)
        }
        await copy
      })
    )
    const uri = `${directory}${kind}.html`
    // The compiler's wasm-bindgen bindings construct functions. The editor only needs WASM evaluation.
    await FileSystem.writeAsStringAsync(
      uri,
      kind === 'pdf'
        ? pdfHtml()
        : `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' ${kind === 'compiler' ? "'unsafe-eval'" : "'wasm-unsafe-eval'"}; worker-src blob:; style-src 'unsafe-inline'; font-src 'self' file:; connect-src 'self' file:; img-src data:">
<style>@font-face {font-family:'JetBrains Mono';src:url('editor-font.ttf')}html,body{margin:0;height:100%}#editor{height:100%}</style>
</head><body><div id="editor"></div><script>window.addEventListener('error',function(event){window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:event.message||'A bundled component could not load.'}))},true)</script><script src="${kind}.bundle.js"></script></body></html>`
    )
    return uri
  })().catch((error: unknown) => {
    pending.delete(kind)
    throw error
  })
  pending.set(kind, result)
  return result
}
