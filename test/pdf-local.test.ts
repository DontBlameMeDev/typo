import { afterEach, beforeEach, expect, test } from 'bun:test'
import { MAX_PDF_BYTES } from '../src/pdf/layout'
import { localBytes } from '../src/pdf/local'

class LocalRequest {
  static latest: LocalRequest
  status = 0
  response: ArrayBuffer | null = null
  responseType = ''
  timeout = 0
  sent = false
  aborted = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onloadend: (() => void) | null = null
  onprogress: ((event: { loaded: number; total: number }) => void) | null = null
  constructor() {
    LocalRequest.latest = this
  }
  open() {}
  send() {
    this.sent = true
  }
  abort() {
    this.aborted = true
    this.onabort?.()
    this.onloadend?.()
  }
  complete(text: string) {
    this.response = new TextEncoder().encode(text).buffer
    this.onload?.()
    this.onloadend?.()
  }
}
const original = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
beforeEach(() => {
  Object.defineProperty(globalThis, 'XMLHttpRequest', { value: LocalRequest, configurable: true })
})
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original)
  else Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
})

test('local PDF reads accept file status zero without a base64 bridge copy', async () => {
  const result = localBytes('file:///cache/preview.pdf')
  expect(LocalRequest.latest.responseType).toBe('arraybuffer')
  LocalRequest.latest.complete('%PDF-1.7')
  expect(new TextDecoder().decode(await result)).toBe('%PDF-1.7')
})

test('local PDF reads reject unavailable and empty resources', async () => {
  const missing = localBytes('file:///cache/missing.pdf')
  LocalRequest.latest.status = 404
  LocalRequest.latest.complete('missing')
  await expect(missing).rejects.toThrow('Cannot read')
  const empty = localBytes('file:///cache/empty.pdf')
  LocalRequest.latest.complete('')
  await expect(empty).rejects.toThrow('empty')
})

test('oversized PDFs abort during transfer and are also checked after transfer', async () => {
  const large = localBytes('file:///cache/large.pdf', { maxBytes: MAX_PDF_BYTES })
  LocalRequest.latest.onprogress?.({ loaded: 1, total: MAX_PDF_BYTES + 1 })
  await expect(large).rejects.toThrow('100 MiB')
  expect(LocalRequest.latest.aborted).toBe(true)
  const oversized = localBytes('file:///cache/large.pdf', { maxBytes: 5 })
  LocalRequest.latest.complete('too large')
  await expect(oversized).rejects.toThrow('100 MiB')
})

test('changing the PDF aborts its old file read', async () => {
  const controller = new AbortController()
  const reading = localBytes('file:///cache/old.pdf', { signal: controller.signal })
  controller.abort()
  await expect(reading).rejects.toThrow('canceled')
  expect(LocalRequest.latest.aborted).toBe(true)
  const canceled = localBytes('file:///cache/old.pdf', { signal: controller.signal })
  await expect(canceled).rejects.toThrow('canceled')
  expect(LocalRequest.latest.sent).toBe(false)
})

test('read errors and timeouts reach the viewer instead of leaving it loading', async () => {
  const failed = localBytes('file:///cache/failed.pdf')
  LocalRequest.latest.onerror?.()
  await expect(failed).rejects.toThrow('Cannot read')
  const slow = localBytes('file:///cache/slow.pdf')
  LocalRequest.latest.ontimeout?.()
  await expect(slow).rejects.toThrow('timed out')
})
