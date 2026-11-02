import { localBytes } from '../editor/local'
import type { CompileRequest } from './protocol'

declare global {
  interface Window {
    typoCompile(request: CompileRequest): Promise<void>
  }
}
const send = (value: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(value))
let activeId: number | undefined
const start = (async () => {
  const code = await localBytes('compiler-worker.bundle.js')
  const url = URL.createObjectURL(
    new Blob([code as Uint8Array<ArrayBuffer>], { type: 'text/javascript' })
  )
  const worker = new Worker(url)
  const ready = new Promise<void>((resolve, reject) => {
    worker.onmessage = (event) => {
      if (event.data.type === 'ready') {
        URL.revokeObjectURL(url)
        resolve()
      } else {
        if (event.data.type === 'error' && event.data.id == null)
          reject(new Error(event.data.message))
        else send(event.data)
      }
    }
    worker.onerror = (event) => {
      URL.revokeObjectURL(url)
      const message = event.message || 'The compiler stopped. Reopen the note to retry.'
      reject(new Error(message))
      send({ type: 'crash', id: activeId, message })
    }
  })
  // Attach before fetching resources so startup failures cannot become unhandled rejections.
  void ready.catch(() => {})
  const [wasm, ...fonts] = await Promise.all(
    [
      'compiler.wasm',
      'editor-font.ttf',
      'serif-regular.otf',
      'serif-bold.otf',
      'serif-italic.otf',
      'math.otf',
    ].map(localBytes)
  )
  worker.postMessage(
    { type: 'init', wasm, fonts },
    [wasm, ...fonts].map((bytes) => bytes.buffer)
  )
  await ready
  return worker
})()
window.typoCompile = async (request) => {
  try {
    activeId = request.id
    const worker = await start
    worker.postMessage({ type: 'compile', request })
  } catch (cause) {
    send({
      type: 'error',
      id: request.id,
      message: cause instanceof Error ? cause.message : 'Cannot load the compiler.',
    })
  }
}
void start
  .then(() => send({ type: 'boot' }))
  .catch((cause: unknown) =>
    send({
      type: 'error',
      message: cause instanceof Error ? cause.message : 'Cannot load the compiler.',
    })
  )
