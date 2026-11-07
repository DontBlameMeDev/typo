import { fromBase64, toBase64 } from '../editor/local'
import { createCompiler, initializeCompiler } from './engine'
import { type CompileRequest, packageKey, vaultPath } from './protocol'

type Input =
  | { type: 'init'; wasm: Uint8Array; fonts: Uint8Array[] }
  | { type: 'compile'; request: CompileRequest }
const endpoint = globalThis as unknown as {
  postMessage(value: object): void
  onmessage: ((event: MessageEvent<Input>) => void) | null
}
let fonts: Uint8Array[] = []
let busy = false
let files = new Map<string, Uint8Array>()
const archives = new Map<string, Uint8Array>()
let compiler: Awaited<ReturnType<typeof createCompiler>> | null = null
let previousMain: { path: string; bytes: Uint8Array | undefined } | null = null
endpoint.onmessage = (event) => {
  void (async () => {
    const input = event.data
    if (input.type === 'init') {
      try {
        await initializeCompiler(input.wasm)
        fonts = input.fonts
        endpoint.postMessage({ type: 'ready' })
      } catch (cause) {
        endpoint.postMessage({
          type: 'error',
          message: cause instanceof Error ? cause.message : 'Cannot initialize the compiler.',
        })
      }
      return
    }
    const { request } = input
    const send = (value: object) => endpoint.postMessage({ ...value, id: request.id })
    if (busy) {
      send({ type: 'error', message: 'The compiler is already running.' })
      return
    }
    busy = true
    try {
      if (previousMain) {
        if (previousMain.bytes) files.set(previousMain.path, previousMain.bytes)
        else files.delete(previousMain.path)
        previousMain = null
      }
      const fontsChanged =
        request.files?.some((file) => /\.(ttf|otf|ttc)$/iu.test(file.path)) ||
        request.removed?.some((path) => /\.(ttf|otf|ttc)$/iu.test(path))
      if (request.resetFiles || fontsChanged) {
        compiler?.dispose()
        compiler = null
      }
      if (request.resetFiles) files = new Map()
      for (const file of request.files ?? [])
        files.set(vaultPath(file.path), fromBase64(file.base64))
      for (const path of request.removed ?? []) files.delete(vaultPath(path))
      const main = vaultPath(request.path)
      previousMain = { path: main, bytes: files.get(main) }
      files.set(main, new TextEncoder().encode(request.source))
      for (const archive of request.archives) archives.set(archive.key, fromBase64(archive.base64))
      if (!compiler) {
        const currentFonts = [...fonts]
        for (const [path, bytes] of files)
          if (/\.(ttf|otf|ttc)$/iu.test(path)) currentFonts.push(bytes)
        compiler = await createCompiler(files, currentFonts, archives)
      }
      const result = compiler.compile(request.path)
      if (result.missing.length)
        send({
          type: 'packages',
          packages: result.missing.map((spec) => ({ ...spec, key: packageKey(spec) })),
        })
      else if (result.pdf)
        send({ type: 'pdf', base64: toBase64(result.pdf), dependencies: result.dependencies })
      else if (result.diagnostics.length)
        send({
          type: 'diagnostics',
          message: result.diagnostics.join('\n'),
          issues: result.issues,
        })
      else send({ type: 'error', message: 'Typst could not generate this PDF.' })
    } catch (cause) {
      send({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      busy = false
    }
  })()
}
