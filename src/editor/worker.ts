import type { HighlightRequest, HighlightResponse } from './highlight-queue'
import { TypstSyntax, typstLanguage } from './syntax'

type Input = HighlightRequest | { type: 'init'; runtime: Uint8Array; grammar: Uint8Array }
const endpoint = globalThis as unknown as {
  postMessage(value: HighlightResponse): void
  onmessage: ((event: MessageEvent<Input>) => void) | null
}
let syntax: TypstSyntax | null = null
let source = ''

endpoint.onmessage = async (event) => {
  try {
    const request = event.data
    if (request.type === 'init') {
      syntax = new TypstSyntax(await typstLanguage(request.runtime, request.grammar))
      endpoint.postMessage({ type: 'ready' })
    } else {
      if (!syntax) throw new Error('Syntax highlighting is not ready.')
      if (request.source !== undefined) source = request.source
      endpoint.postMessage({
        type: 'highlights',
        id: request.id,
        ranges: syntax.highlights(source, request.range),
      })
    }
  } catch (cause) {
    endpoint.postMessage({ type: 'error', message: String(cause) })
  }
}
