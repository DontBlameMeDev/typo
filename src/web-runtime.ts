import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import { pdfHtml } from './pdf/document'

const resources = {
  pdf: {
    'pdf.bundle.js': require('../dist/pdf.bundle.txt'),
    'pdf-worker.bundle.js': require('../dist/pdf-worker.bundle.txt'),
    'pdf-resources.json': require('../dist/pdf-resources.txt'),
  },
  editor: {
    'editor.bundle.js': require('../dist/editor.bundle.txt'),
    'tree-sitter.wasm': require('web-tree-sitter/web-tree-sitter.wasm'),
    'typst-grammar.wasm': require('@lumis-sh/wasm-typst/tree-sitter-typst.wasm'),
    'editor-font.ttf': require('../assets/fonts/JetBrainsMonoNerdFont-Regular.ttf'),
  },
  compiler: {
    'compiler.bundle.js': require('../dist/compiler.bundle.txt'),
    'compiler-worker.bundle.js': require('../dist/compiler-worker.bundle.txt'),
    'compiler.wasm': require('@myriaddreamin/typst-ts-web-compiler/wasm'),
    'editor-font.ttf': require('../assets/fonts/JetBrainsMonoNerdFont-Regular.ttf'),
    'serif-regular.otf': require('../assets/fonts/typst/LibertinusSerif-Regular.otf'),
    'serif-bold.otf': require('../assets/fonts/typst/LibertinusSerif-Bold.otf'),
    'serif-italic.otf': require('../assets/fonts/typst/LibertinusSerif-Italic.otf'),
    'math.otf': require('../assets/fonts/typst/NewCMMath-Regular.otf'),
  },
}
const pending = new Map<string, Promise<string>>()
const installed = new Map<string, Promise<void>>()
let pdfResources: Promise<void> | null = null

function installPdfResources(directory: string): Promise<void> {
  pdfResources ??= (async () => {
    const manifest: Record<string, string> = JSON.parse(
      await FileSystem.readAsStringAsync(`${directory}pdf-resources.json`)
    )
    for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs'])
      await FileSystem.makeDirectoryAsync(`${directory}pdf/${folder}/`, { intermediates: true })
    // Limit concurrent bridge writes while unpacking the offline decoder resources.
    const entries = Object.entries(manifest)
    for (let index = 0; index < entries.length; index += 8)
      await Promise.all(
        entries.slice(index, index + 8).map(([path, base64]) => {
          if (!/^(cmaps|standard_fonts|wasm|iccs)\/[\w.-]+$/.test(path))
            throw new Error('Invalid bundled PDF resource path.')
          return FileSystem.writeAsStringAsync(`${directory}pdf/${path}`, base64, {
            encoding: FileSystem.EncodingType.Base64,
          })
        })
      )
  })().catch((cause: unknown) => {
    pdfResources = null
    throw cause
  })
  return pdfResources
}

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
    if (kind === 'pdf') await installPdfResources(directory)
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
${kind === 'editor' ? '<link rel="preload" href="editor-font.ttf" as="font" type="font/ttf" crossorigin>' : ''}
<style>@font-face {font-family:'JetBrains Mono Nerd Font';src:url('editor-font.ttf')}html,body{margin:0;height:100%}#editor{height:100%}</style>
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
