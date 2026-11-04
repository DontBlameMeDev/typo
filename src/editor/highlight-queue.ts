import type { Text } from '@codemirror/state'
import type { Highlight } from './syntax'

export type HighlightRequest = {
  type: 'highlight'
  id: number
  source?: string
  range: { from: number; to: number }
}

export type HighlightResponse =
  | { type: 'ready' }
  | { type: 'highlights'; id: number; ranges: Highlight[] }
  | { type: 'error'; message: string }

type Pending = {
  id: number
  doc: Text
  range: { from: number; to: number }
  apply(ranges: Highlight[]): void
}

export class HighlightQueue {
  private sequence = 0
  private booted = false
  private disposed = false
  private active: Pending | null = null
  private pending: Pending | null = null
  private sent: Text | null = null

  constructor(private send: (request: HighlightRequest) => void) {}

  ready() {
    this.booted = true
    this.pump()
  }

  request(doc: Text, range: Pending['range'], apply: Pending['apply']) {
    if (this.disposed) return
    this.pending = { id: ++this.sequence, doc, range, apply }
    this.pump()
  }

  complete(id: number, ranges: Highlight[]) {
    if (this.disposed || this.active?.id !== id) return
    const active = this.active
    this.active = null
    if (id === this.sequence) active.apply(ranges)
    this.pump()
  }

  dispose() {
    this.disposed = true
    this.pending = null
    this.active = null
    this.sent = null
  }

  private pump() {
    if (this.disposed || !this.booted || this.active || !this.pending) return
    const next = this.pending
    this.pending = null
    this.active = next
    this.send({
      type: 'highlight',
      id: next.id,
      range: next.range,
      ...(next.doc !== this.sent && { source: next.doc.toString() }),
    })
    this.sent = next.doc
  }
}
