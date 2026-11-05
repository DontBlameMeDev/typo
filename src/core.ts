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

type NameEntry = {
  note: Note
  text: string
  folded: string
}

type LineEntry = NameEntry & { line: number }

type ContentEntry = {
  note: Note
  text: string
  folded: string
  textStarts?: number[]
  foldedStarts?: number[]
  lines?: LineEntry[]
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

function nameEntry(note: Note, text: string): NameEntry {
  return { note, text, folded: foldSearchText(text) }
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

function lineStarts(text: string): number[] {
  const starts = [0]
  let index = text.indexOf('\n')
  while (index !== -1) {
    starts.push(index + 1)
    index = text.indexOf('\n', index + 1)
  }
  return starts
}

function lineEnd(starts: number[], length: number, line: number): number {
  return line + 1 < starts.length ? starts[line + 1] - 1 : length
}

function contentLines(entry: ContentEntry): LineEntry[] {
  if (entry.lines) return entry.lines
  const texts = entry.text.split('\n')
  const folded = entry.folded.split('\n')
  const lines: LineEntry[] = []
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index].trim()
    if (text)
      lines.push({
        note: entry.note,
        text,
        folded: folded[index].trim(),
        line: index + 1,
      })
  }
  entry.lines = lines
  return lines
}

export type NoteSearch = ((
  query: string,
  mode: SearchMode,
  cancelled?: () => boolean
) => Promise<SearchResult[]>) & {
  update(notes: readonly Note[]): void
}

export function createNoteSearch(initial: readonly Note[]): NoteSearch {
  let notes = initial
  let names = nameIndex(notes)
  let all: { note: Note }[] | null = null
  let entries: ContentEntry[] | null = null
  let content: Promise<ContentEntry[]> | undefined
  let version = 0
  let request = 0

  const patch = (current: ContentEntry[], next: readonly Note[]): ContentEntry[] => {
    const sameOrder =
      next.length === current.length && next.every((note, i) => note.path === current[i].note.path)
    const byPath = sameOrder ? null : new Map(current.map((entry) => [entry.note.path, entry]))
    return next.map((note, index) => {
      const entry = byPath ? byPath.get(note.path) : current[index]
      if (entry && entry.note.source === note.source) {
        entry.note = note
        return entry
      }
      return { note, text: note.source, folded: foldSearchText(note.source) }
    })
  }

  const indexContent = async (snapshot: readonly Note[], builtVersion: number) => {
    const built: ContentEntry[] = []
    const pause = searchBudget()
    let size = 0
    for (const note of snapshot) {
      const source = note.source
      built.push({ note, text: source, folded: foldSearchText(source) })
      size += source.length
      if ((built.length & 63) === 0) await pause()
    }
    // A large note can fold inside one budget slice, so always let timers run once.
    if (size >= 262144) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    entries = builtVersion === version ? built : patch(built, notes)
    content = Promise.resolve(entries)
    return entries
  }

  const search = async (
    query: string,
    mode: SearchMode,
    cancelled = () => false
  ): Promise<SearchResult[]> => {
    const current = ++request
    const pause = searchBudget()
    const value = query.trim()
    if (!value) {
      all ??= notes.map((note) => ({ note }))
      return all
    }
    const folded = foldSearchText(value)
    const lower = value.toLowerCase()
    const found = new Map<string, RankedResult>()
    const add = (entry: LineEntry | NameEntry, rank: number, score: number, start: number) => {
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
      if ('line' in entry) {
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
      if (!content) content = indexContent(notes, version)
      const currentEntries = await content
      for (const entry of currentEntries) {
        if (current !== request || cancelled()) return []
        let at = entry.folded.indexOf(folded)
        let best = -1
        let bestAt = -1
        let bestLine = 0
        let bestLeft = 0
        let line = 0
        let foldedStarts: number[] | undefined
        while (at >= 0) {
          entry.foldedStarts ??= lineStarts(entry.folded)
          foldedStarts ??= entry.foldedStarts
          while (line + 1 < foldedStarts.length && foldedStarts[line + 1] <= at) line++
          const rawEnd = lineEnd(foldedStarts, entry.folded.length, line)
          let left = foldedStarts[line]
          let end = rawEnd
          while (left < end && entry.folded.charCodeAt(left) <= 32) left++
          while (end > left && entry.folded.charCodeAt(end - 1) <= 32) end--
          const length = end - left
          const position = at - left
          if (position >= 0 && at + folded.length <= end) {
            const score = literalScore(
              length,
              length === folded.length,
              position,
              position === 0 || isBoundary(entry.folded, at)
            )
            if (best < 0 || score > best) {
              best = score
              bestAt = at
              bestLine = line
              bestLeft = left
            }
          }
          at = entry.folded.indexOf(folded, rawEnd + 1)
        }
        // A literal hit always outranks a fuzzy one for the same note.
        if (best >= 0) {
          let textStarts = foldedStarts as number[]
          if (entry.folded.length !== entry.text.length) {
            entry.textStarts ??= lineStarts(entry.text)
            textStarts = entry.textStarts
          }
          const textEnd = lineEnd(textStarts, entry.text.length, bestLine)
          const text = entry.text.slice(textStarts[bestLine], textEnd).trim()
          add(
            { note: entry.note, text, folded: '', line: bestLine + 1 },
            1,
            best,
            bestAt - bestLeft
          )
        } else
          for (const item of contentLines(entry)) {
            const match = fuzzyScore(item.folded, folded)
            if (match) add(item, 3, match.score, match.start)
          }
        await pause()
      }
    }
    return [...found.values()]
      .sort((a, b) => a.rank - b.rank || b.score - a.score || a.length - b.length)
      .map(({ result }) => result)
  }

  search.update = (next: readonly Note[]) => {
    const renamed =
      next.length !== notes.length ||
      next.some((note, i) => note.path !== notes[i].path || note.title !== notes[i].title)
    notes = next
    if (renamed) names = nameIndex(next)
    all = null
    version++
    request++
    if (entries) {
      entries = patch(entries, next)
      content = Promise.resolve(entries)
    }
  }

  return search
}

function nameIndex(notes: readonly Note[]) {
  return new Fzf(
    notes.flatMap((note) => [nameEntry(note, note.title), nameEntry(note, note.path)]),
    {
      selector: (entry: NameEntry) => entry.text,
      casing: 'case-insensitive' as const,
      sort: false,
    }
  )
}
