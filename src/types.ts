import { sha256 } from './hash'

export type Vault = {
  uri: string
  name: string
}

export type Note = {
  path: string
  uri: string
  title: string
  source: string
  modifiedAt: number | null
  pdfUri?: string
  pdfHash?: string
}

const hashes = new WeakMap<Note, { source: string; hash: string }>()

export function hasCurrentPdf(note: Note): boolean {
  if (!note.pdfUri || !note.pdfHash) return false
  const cached = hashes.get(note)
  const hash = cached?.source === note.source ? cached.hash : sha256(note.source)
  hashes.set(note, { source: note.source, hash })
  return hash === note.pdfHash
}

export type SearchMode = 'all' | 'names' | 'content'

export type SearchResult = {
  note: Note
  snippet?: string
  line?: number
}
