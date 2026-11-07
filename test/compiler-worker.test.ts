import { beforeAll, expect, test } from 'bun:test'
import type { CompileRequest } from '../src/compiler/protocol'

type Message = { type: string; id?: number; message?: string; base64?: string }

const messages: Message[] = []
let wake: (() => void) | null = null
const endpoint = globalThis as unknown as {
  postMessage(value: Message): void
  onmessage(event: { data: unknown }): void
}
endpoint.postMessage = (value) => {
  messages.push(value)
  wake?.()
}
await import('../src/compiler/worker')

const next = async () => {
  while (!messages.length) await new Promise<void>((resolve) => (wake = resolve))
  return messages.shift() as Message
}
const compile = async (request: CompileRequest) => {
  endpoint.onmessage({ data: { type: 'compile', request } })
  return next()
}

beforeAll(async () => {
  const wasm = new Uint8Array(
    await Bun.file(
      'node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm'
    ).arrayBuffer()
  )
  const fonts = await Promise.all(
    ['assets/fonts/typst/LibertinusSerif-Regular.otf'].map(
      async (path) => new Uint8Array(await Bun.file(path).arrayBuffer())
    )
  )
  endpoint.onmessage({ data: { type: 'init', wasm, fonts } })
  expect(await next()).toEqual({ type: 'ready' })
})

test('the worker reports Typst diagnostics apart from runtime failures', async () => {
  const request = { id: 1, path: 'bad.typ', source: '#unknown-function()', archives: [] }
  const diagnostics = await compile(request)
  expect(diagnostics.type).toBe('diagnostics')
  expect(diagnostics.message).toContain('unknown variable')

  // An unsafe path fails before Typst runs, so it is a runtime failure, not a diagnostic.
  const runtime = await compile({ ...request, id: 2, path: '../escape.typ' })
  expect(runtime.type).toBe('error')
  expect(runtime.id).toBe(2)
})
