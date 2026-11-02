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

function contentMatch(note: Note, query: string): SearchResult | undefined {
  const lines = note.source.split('\n')
  const index = lines.findIndex((line) => line.toLocaleLowerCase().includes(query))
  if (index === -1) return undefined
  const line = lines[index].trim()
  const position = line.toLocaleLowerCase().indexOf(query)
  const start = Math.max(0, position - 50)
  return {
    note,
    line: index + 1,
    snippet: `${start ? '…' : ''}${line.slice(start, start + 180)}${line.length > start + 180 ? '…' : ''}`,
  }
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

export function searchNotes(notes: Note[], query: string, mode: SearchMode): SearchResult[] {
  const value = query.trim()
  if (!value) return notes.map((note) => ({ note }))
  const results: SearchResult[] = []
  const found = new Set<string>()
  if (mode !== 'content') {
    const finder = new Fzf(notes, { selector: (note) => `${note.title} ${note.path}` })
    for (const { item } of finder.find(value)) {
      results.push({ note: item })
      found.add(item.path)
    }
  }
  if (mode !== 'names') {
    const lower = value.toLocaleLowerCase()
    for (const note of notes) {
      if (found.has(note.path)) continue
      const match = contentMatch(note, lower)
      if (match) results.push(match)
    }
  }
  return results
}
