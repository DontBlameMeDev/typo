import { expect, test } from 'bun:test'
import { Text } from '@codemirror/state'
import {
  HighlightQueue,
  type HighlightRequest,
  type HighlightResponse,
} from '../src/editor/highlight-queue'
import type { Highlight } from '../src/editor/syntax'

const range = { from: 0, to: 10 }

test('highlighting waits for worker startup and keeps only the latest document', () => {
  const sent: HighlightRequest[] = []
  const queue = new HighlightQueue((request) => sent.push(request))
  queue.request(Text.of(['old']), range, () => {})
  queue.request(Text.of(['new 📝']), range, () => {})
  expect(sent).toHaveLength(0)
  queue.ready()
  expect(sent).toEqual([{ type: 'highlight', id: 2, source: 'new 📝', range }])
})

test('highlighting allows one active request, coalesces edits, and ignores stale results', () => {
  const sent: HighlightRequest[] = []
  const applied: Highlight[][] = []
  const queue = new HighlightQueue((request) => sent.push(request))
  queue.ready()
  queue.request(Text.of(['first']), range, (ranges) => applied.push(ranges))
  queue.request(Text.of(['skipped']), range, (ranges) => applied.push(ranges))
  queue.request(Text.of(['latest']), range, (ranges) => applied.push(ranges))
  expect(sent).toHaveLength(1)
  queue.complete(1, [{ from: 0, to: 2, style: 'number' }])
  expect(applied).toEqual([])
  expect(sent.map((request) => request.source)).toEqual(['first', 'latest'])
  queue.complete(1, [])
  expect(sent).toHaveLength(2)
  queue.complete(3, [])
  expect(applied).toEqual([[]])
})

test('scrolling does not transfer the same document again', () => {
  const sent: HighlightRequest[] = []
  const queue = new HighlightQueue((request) => sent.push(request))
  const doc = Text.of(['#let x = 42', '// comment'])
  queue.ready()
  queue.request(doc, range, () => {})
  queue.complete(1, [])
  queue.request(doc, { from: 10, to: doc.length }, () => {})
  expect(sent[1]).toEqual({
    type: 'highlight',
    id: 2,
    range: { from: 10, to: doc.length },
  })
})

test('disposed highlighting drops callbacks and queued work', () => {
  const sent: HighlightRequest[] = []
  const queue = new HighlightQueue((request) => sent.push(request))
  queue.ready()
  queue.request(Text.of(['first']), range, () => {
    throw new Error('stale callback')
  })
  queue.request(Text.of(['next']), range, () => {
    throw new Error('stale callback')
  })
  queue.dispose()
  queue.complete(1, [])
  queue.request(Text.of(['closed']), range, () => {})
  queue.ready()
  expect(sent).toHaveLength(1)
})

test('the real editor worker parses edits and reuses source for viewport-only requests', async () => {
  const worker = new Worker(new URL('../src/editor/worker.ts', import.meta.url).href)
  const ask = (request: object) => {
    const response = new Promise<HighlightResponse>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data)
      worker.onerror = (event) => reject(new Error(event.message))
    })
    worker.postMessage(request)
    return response
  }
  try {
    expect(
      await ask({
        type: 'init',
        runtime: new Uint8Array(
          await Bun.file('node_modules/web-tree-sitter/web-tree-sitter.wasm').arrayBuffer()
        ),
        grammar: new Uint8Array(
          await Bun.file('node_modules/@lumis-sh/wasm-typst/tree-sitter-typst.wasm').arrayBuffer()
        ),
      })
    ).toEqual({ type: 'ready' })
    const source = '#let emoji = "📝"\n// A comment\n#let x = 42'
    const first = await ask({
      type: 'highlight',
      id: 1,
      source,
      range: { from: 0, to: source.length },
    })
    if (first.type !== 'highlights') throw new Error(`Unexpected response: ${first.type}`)
    for (const style of ['keyword', 'string', 'comment', 'number'])
      expect(first.ranges.some((item) => item.style === style)).toBe(true)
    const viewport = { from: 20, to: source.length }
    const scrolled = await ask({ type: 'highlight', id: 2, range: viewport })
    if (scrolled.type !== 'highlights') throw new Error(`Unexpected response: ${scrolled.type}`)
    expect(scrolled.ranges).toEqual(
      first.ranges
        .map((item) => ({ ...item, from: Math.max(item.from, viewport.from) }))
        .filter((item) => item.from < item.to)
    )
    const changed = await ask({
      type: 'highlight',
      id: 3,
      source: '// New note 📝',
      range: { from: 0, to: 14 },
    })
    if (changed.type !== 'highlights') throw new Error(`Unexpected response: ${changed.type}`)
    expect(changed.ranges).toEqual([{ from: 0, to: 14, style: 'comment' }])
  } finally {
    worker.terminate()
  }
}, 10000)
