import { basicMatch, Fzf, type FzfOptions } from 'fzf'
import type { Note, SearchMode, SearchResult } from './types'

export type NoteTemplate = {
  id: string
  name: string
  source: string
}

const CLASSIC_TEMPLATE =
  '#import "style/lib.typ": *\n#show: template\n\n#title[{{title}}]\n\n{{body}}\n'

const PLAIN_TEMPLATE = `#set page(margin: 2.5cm)

#let title(body) = align(center, text(size: 22pt, weight: "bold", body))
#title[{{title}}]

{{body}}
`

export const BUILTIN_TEMPLATES: readonly NoteTemplate[] = [
  { id: 'builtin:plain', name: 'Plain note', source: PLAIN_TEMPLATE },
]

const PLACEHOLDER = /\{\{([^{}]*)\}\}/gu

export function noteFilename(title: string): string {
  const value = title.normalize('NFC').trim()
  if (!value) throw new Error('Give your note a title.')
  if (/[/\\:*?"<>|\p{Cc}]/u.test(value) || value.startsWith('.')) {
    throw new Error('Use a title without slashes, control characters, or filename punctuation.')
  }
  const stem = value
    .toLowerCase()
    .replace(/\s+/gu, '_')
    .replace(/\.typ$/u, '')
  if (
    !stem ||
    stem.endsWith('.') ||
    encodeURIComponent(stem).replace(/%[A-F\d]{2}/gu, '_').length > 180
  ) {
    throw new Error('Use a shorter title without a trailing period.')
  }
  return `${stem}.typ`
}

export function buildNoteSource(title: string, body: string, template?: string): string {
  noteFilename(title)
  const escaped = title.trim().replace(/[\\#[\]*_$@<>`~]/gu, '\\$&')
  if (template === undefined) return fillTemplate(CLASSIC_TEMPLATE, escaped, body.trimEnd())
  return fillTemplate(template, escaped, body.trimEnd())
}

function fillTemplate(template: string, escapedTitle: string, body: string): string {
  let foundTitle = false
  const result = template.replace(PLACEHOLDER, (placeholder, field: string) => {
    if (field === 'title') {
      foundTitle = true
      return escapedTitle
    }
    if (field === 'body') return body
    throw new Error(
      `The note template uses an unknown placeholder ${placeholder}. Use only {{title}} and {{body}}.`
    )
  })
  if (!foundTitle) throw new Error('The note template must include {{title}}.')
  return result
}

export function foldersFromNotes(notes: readonly Note[]): string[] {
  const folders = new Set<string>([''])
  for (const note of notes) {
    const segments = note.path.split('/')
    segments.pop()
    let path = ''
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment
      folders.add(path)
    }
  }
  return [...folders].sort((a, b) => a.localeCompare(b))
}

export function extractTitle(source: string, fallback: string): string {
  const start = /#title\s*\[/u.exec(source)
  if (!start) return fallback.replace(/\.typ$/iu, '').replace(/_/gu, ' ')
  let depth = 1
  let title = ''
  for (let i = start.index + start[0].length; i < source.length; i++) {
    const character = source[i]
    if (character === '\\' && i + 1 < source.length) {
      title += source[++i]
      continue
    }
    if (character === '[') depth++
    if (character === ']') depth--
    if (depth === 0) return title.replace(/\s+/gu, ' ').trim() || fallback
    title += character
  }
  return fallback.replace(/\.typ$/iu, '').replace(/_/gu, ' ')
}

type SearchEntry = {
  note: Note
  text: string
  folded: string
  line?: number
}

export function reconcileNotes(previous: Note[], next: Note[]): Note[] {
  const byUri = new Map(previous.map((note) => [note.uri, note]))
  const result = next.map((note) => {
    const old = byUri.get(note.uri)
    return old &&
      old.path === note.path &&
      old.source === note.source &&
      old.title === note.title &&
      old.pdfUri === note.pdfUri &&
      old.modifiedAt === note.modifiedAt
      ? old
      : note
  })
  return result.length === previous.length && result.every((note, i) => note === previous[i])
    ? previous
    : result
}

type RankedResult = {
  result: SearchResult
  rank: number
  score: number
  length: number
}

function foldSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function searchEntry(note: Note, text: string, line?: number): SearchEntry {
  return { note, text, folded: foldSearchText(text), line }
}

const contentMatch: NonNullable<FzfOptions<SearchEntry>['match']> = function (query) {
  const match = this.algoFn
  // Search results use scores and starts, never per-character positions.
  this.algoFn = (casing, normalize, forward, text, pattern, _positions, slab) =>
    match(casing, normalize, forward, text, pattern, false, slab)
  try {
    return (basicMatch<SearchEntry>).call(this, query)
  } finally {
    this.algoFn = match
  }
}

function searchBudget() {
  let started = performance.now()
  return async () => {
    if (performance.now() - started < 6) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    started = performance.now()
  }
}

export function createNoteSearch(notes: readonly Note[]) {
  const options = {
    selector: (entry: SearchEntry) => entry.text,
    casing: 'case-insensitive' as const,
    sort: false,
  }
  const names = new Fzf(
    notes.flatMap((note) => [searchEntry(note, note.title), searchEntry(note, note.path)]),
    options
  )
  let content: Promise<Fzf<SearchEntry[]>[]> | undefined
  const all = notes.map((note) => ({ note }))
  let request = 0

  const indexContent = async () => {
    const chunks: Fzf<SearchEntry[]>[] = []
    const pause = searchBudget()
    let entries: SearchEntry[] = []
    const flush = () => {
      chunks.push(new Fzf(entries, { ...options, fuzzy: 'v1', match: contentMatch }))
      entries = []
    }
    for (const note of notes) {
      const lines = note.source.split('\n')
      for (let index = 0; index < lines.length; index++) {
        const text = lines[index].trim()
        if (text) entries.push(searchEntry(note, text, index + 1))
        if (entries.length === 256) {
          flush()
          await pause()
        }
      }
    }
    if (entries.length) flush()
    return chunks
  }

  return async (
    query: string,
    mode: SearchMode,
    cancelled = () => false
  ): Promise<SearchResult[]> => {
    const current = ++request
    const pause = searchBudget()
    const value = query.trim()
    if (!value) return all
    const folded = foldSearchText(value)
    const lower = value.toLowerCase()
    const found = new Map<string, RankedResult>()
    const add = (entry: SearchEntry, rank: number, score: number, start: number) => {
      const previous = found.get(entry.note.path)
      if (
        previous &&
        (previous.rank < rank ||
          (previous.rank === rank &&
            (previous.score > score ||
              (previous.score === score && previous.length <= entry.text.length))))
      )
        return
      const result: SearchResult = { note: entry.note }
      if (entry.line !== undefined) {
        const literal = entry.text.toLowerCase().indexOf(lower)
        const from = Math.max(0, (literal >= 0 ? literal : start) - 50)
        result.line = entry.line
        result.snippet = `${from ? '…' : ''}${entry.text.slice(from, from + 180)}${entry.text.length > from + 180 ? '…' : ''}`
      }
      found.set(entry.note.path, { result, rank, score, length: entry.text.length })
    }

    if (mode !== 'content') {
      for (const { item, score, start } of names.find(value)) {
        add(item, item.folded.includes(folded) ? 0 : 2, score, start)
      }
    }
    if (mode !== 'names') {
      content ??= indexContent()
      const chunks = await content
      for (const chunk of chunks) {
        if (current !== request || cancelled()) return []
        for (const { item, score, start } of chunk.find(value)) {
          add(item, item.folded.includes(folded) ? 1 : 3, score, start)
        }
        await pause()
      }
    }
    return [...found.values()]
      .sort((a, b) => a.rank - b.rank || b.score - a.score || a.length - b.length)
      .map(({ result }) => result)
  }
}
