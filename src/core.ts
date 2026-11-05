import { Fzf } from 'fzf'
import type { Note, SearchMode, SearchResult } from './types'

export const DEFAULT_TEMPLATE = `#set page(margin: 2.5cm)

#let title(body) = align(center, text(size: 22pt, weight: "bold", body))
#title[{{title}}]

{{body}}
`

const PLACEHOLDER = /\{\{([^{}]*)\}\}/gu

export function isRootTemplate(path: string): boolean {
  return path.toLowerCase() === 'template.typ'
}

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

export function buildNoteSource(title: string, body: string, template = DEFAULT_TEMPLATE): string {
  noteFilename(title)
  const escaped = title.trim().replace(/[\\#[\]*_$@<>`~]/gu, '\\$&')
  return fillTemplate(template, escaped, body.trimEnd())
}

export function validateNoteTemplate(template: string): void {
  fillTemplate(template, '', '')
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
  if (fallback.toLowerCase() === 'template.typ') return 'Template'
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
  for (let index = 0; index < text.length; index++)
    if (text.charCodeAt(index) > 127)
      return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  return text.toLowerCase()
}

function searchEntry(note: Note, text: string, line?: number): SearchEntry {
  return { note, text, folded: foldSearchText(text), line }
}

function searchBudget() {
  let started = performance.now()
  return async () => {
    if (performance.now() - started < 6) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    started = performance.now()
  }
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const code = text.charCodeAt(index - 1)
  return !((code >= 48 && code <= 57) || (code >= 97 && code <= 122))
}

function literalScore(length: number, exact: boolean, at: number, boundary: boolean): number {
  return 10000 - length + (exact ? 5000 : 0) + (boundary ? 100 : 0) - Math.min(at, 100)
}

function fuzzyScore(text: string, pattern: string): { score: number; start: number } | null {
  let position = -1
  let first = -1
  let score = 0
  let run = 0
  for (let index = 0; index < pattern.length; index++) {
    const at = text.indexOf(pattern[index], position + 1)
    if (at < 0) return null
    if (first < 0) first = at
    const gap = at - position - 1
    if (gap === 0) run++
    else {
      run = 0
      score -= Math.min(gap, 8)
    }
    score += 2 + Math.min(run, 3)
    position = at
  }
  score -= text.length * 0.02 + Math.min(first, 40) * 0.1
  return { score, start: first }
}

export function createNoteSearch(notes: readonly Note[]) {
  const names = new Fzf(
    notes.flatMap((note) => [searchEntry(note, note.title), searchEntry(note, note.path)]),
    {
      selector: (entry: SearchEntry) => entry.text,
      casing: 'case-insensitive' as const,
      sort: false,
    }
  )
  let content: Promise<SearchEntry[][]> | undefined
  const all = notes.map((note) => ({ note }))
  let request = 0

  const indexContent = async () => {
    const chunks: SearchEntry[][] = []
    const pause = searchBudget()
    let entries: SearchEntry[] = []
    let count = 0
    for (const note of notes) {
      const lines = note.source.split('\n')
      for (let index = 0; index < lines.length; index++) {
        const text = lines[index].trim()
        if (text) {
          entries.push(searchEntry(note, text, index + 1))
          count++
        }
        if (entries.length === 512) {
          chunks.push(entries)
          entries = []
          await pause()
        }
      }
    }
    if (entries.length) chunks.push(entries)
    // Large notes must always let timers run once, even when the budget never trips.
    if (count >= 4096) await new Promise<void>((resolve) => setTimeout(resolve, 0))
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
      for (const { item, score, start } of names.find(value))
        add(item, item.folded.includes(folded) ? 0 : 2, score, start)
    }
    if (mode !== 'names') {
      content ??= indexContent()
      const chunks = await content
      for (const chunk of chunks) {
        if (current !== request || cancelled()) return []
        for (const entry of chunk) {
          const at = entry.folded.indexOf(folded)
          if (at >= 0) {
            add(
              entry,
              1,
              literalScore(
                entry.folded.length,
                entry.folded.length === folded.length,
                at,
                isBoundary(entry.folded, at)
              ),
              at
            )
            continue
          }
          // A literal hit always outranks a fuzzy one for the same note.
          if (found.get(entry.note.path)?.rank === 1) continue
          const match = fuzzyScore(entry.folded, folded)
          if (match) add(entry, 3, match.score, match.start)
        }
        await pause()
      }
    }
    return [...found.values()]
      .sort((a, b) => a.rank - b.rank || b.score - a.score || a.length - b.length)
      .map(({ result }) => result)
  }
}
