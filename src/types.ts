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
}

export type SearchMode = 'all' | 'names' | 'content'

export type SearchResult = {
  note: Note
  snippet?: string
  line?: number
}
