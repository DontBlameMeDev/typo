import { Fzf } from 'fzf'
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
  let content: Fzf<SearchEntry[]> | undefined
  const all = notes.map((note) => ({ note }))

  return (query: string, mode: SearchMode): SearchResult[] => {
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
      // Keep source lines and their fzf representation across keystrokes.
      content ??= new Fzf(
        notes.flatMap((note) =>
          note.source.split('\n').flatMap((text, index) => {
            const trimmed = text.trim()
            return trimmed ? [searchEntry(note, trimmed, index + 1)] : []
          })
        ),
        // The linear matcher keeps full-vault content searches responsive.
        { ...options, fuzzy: 'v1' }
      )
      for (const { item, score, start } of content.find(value)) {
        add(item, item.folded.includes(folded) ? 1 : 3, score, start)
      }
    }
    return [...found.values()]
      .sort((a, b) => a.rank - b.rank || b.score - a.score || a.length - b.length)
      .map(({ result }) => result)
  }
}
