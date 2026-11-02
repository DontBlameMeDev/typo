import { fromBase64, toBase64 } from '../editor/local'
import { compilePdf, initializeCompiler } from './engine'
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
      const currentFonts = [...fonts]
      const files = new Map(
        request.files.map((file) => [vaultPath(file.path), fromBase64(file.base64)])
      )
      files.set(vaultPath(request.path), new TextEncoder().encode(request.source))
      const archives = new Map(
        request.archives.map((archive) => [archive.key, fromBase64(archive.base64)])
      )
      for (const [path, bytes] of files)
        if (/\.(ttf|otf|ttc)$/iu.test(path)) currentFonts.push(bytes)
      send({ type: 'progress', message: 'Updating PDF…' })
      const result = await compilePdf(request.path, files, currentFonts, archives)
      if (result.missing.length)
        send({
          type: 'packages',
          packages: result.missing.map((spec) => ({ ...spec, key: packageKey(spec) })),
        })
      else if (result.pdf) send({ type: 'pdf', base64: toBase64(result.pdf) })
      else
        send({
          type: 'error',
          message: result.diagnostics.join('\n') || 'Typst could not generate this PDF.',
        })
    } catch (cause) {
      send({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      busy = false
    }
  })()
}
