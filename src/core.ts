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

type ContentEntry = {
  note: Note
  text: string
  folded: string
  starts: Int32Array | undefined
}

export type NoteSort = 'name-asc' | 'name-desc' | 'modified-desc' | 'modified-asc'

const titleOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareModified(a: Note, b: Note, direction: number): number {
  if (a.modifiedAt === null || b.modifiedAt === null) {
    if (a.modifiedAt === b.modifiedAt) return 0
    return a.modifiedAt === null ? 1 : -1
  }
  return (a.modifiedAt - b.modifiedAt) * direction
}

export function sortNotes(notes: Note[], sort: NoteSort): Note[] {
  const direction = sort.endsWith('-desc') ? -1 : 1
  const compare = sort.startsWith('name')
    ? (a: Note, b: Note) => titleOrder.compare(a.title, b.title) * direction
    : (a: Note, b: Note) => compareModified(a, b, direction)
  return [...notes].sort((a, b) => compare(a, b) || a.path.localeCompare(b.path))
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
      old.pdfHash === note.pdfHash &&
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

const encoder = new TextEncoder()
let asciiScratch = new Uint8Array(0)

// UTF-8 encoding is a native pass, unlike a per-character scan over the source.
// A string is ASCII exactly when every character encodes to a single byte.
function isAsciiText(text: string): boolean {
  if (asciiScratch.length < text.length) asciiScratch = new Uint8Array(text.length)
  const { read, written } = encoder.encodeInto(text, asciiScratch)
  return read === text.length && written === read
}

function foldSearchText(text: string): string {
  if (isAsciiText(text)) return text.toLowerCase()
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
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

// The fuzzy score of `pattern` inside [start, end), or NaN when the pattern is
// not a subsequence of that range. Scoring against the source keeps long notes
// allocation free: only the winning line is ever sliced.
function fuzzyScoreInRange(text: string, pattern: string, start: number, end: number): number {
  let position = start - 1
  let first = 0
  let score = 0
  let run = 0
  for (let index = 0; index < pattern.length; index++) {
    const at = text.indexOf(pattern[index], position + 1)
    if (at < 0 || at >= end) return Number.NaN
    if (index === 0) first = at - start
    const gap = at - position - 1
    if (gap === 0) run++
    else {
      run = 0
      score -= Math.min(gap, 8)
    }
    score += 2 + Math.min(run, 3)
    position = at
  }
  score -= (end - start) * 0.02 + Math.min(first, 40) * 0.1
  return score
}

// A line can only match when every query character occurs somewhere in the note.
// This is one native scan per character instead of walking every line.
function containsAll(text: string, pattern: string): boolean {
  for (let index = 0; index < pattern.length; index++)
    if (text.indexOf(pattern[index]) < 0) return false
  return true
}

// Same whitespace set as String.prototype.trim.
function isSpace(code: number): boolean {
  if (code > 32 && code < 0x7f) return false
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

let offsetScratch = new Int32Array(256)

function lineStarts(text: string): Int32Array {
  offsetScratch[0] = 0
  let count = 1
  let index = text.indexOf('\n')
  while (index !== -1) {
    if (count === offsetScratch.length) {
      const grown = new Int32Array(offsetScratch.length * 2)
      grown.set(offsetScratch)
      offsetScratch = grown
    }
    offsetScratch[count++] = index + 1
    index = text.indexOf('\n', index + 1)
  }
  return offsetScratch.slice(0, count)
}

function lineOffsets(entry: ContentEntry): Int32Array {
  entry.starts ??= lineStarts(entry.folded)
  return entry.starts
}

function trimmedLine(text: string, line: number): string {
  let start = 0
  for (let index = 0; index < line; index++) {
    const newline = text.indexOf('\n', start)
    if (newline < 0) return ''
    start = newline + 1
  }
  const newline = text.indexOf('\n', start)
  return text.slice(start, newline < 0 ? text.length : newline).trim()
}

function lineText(entry: ContentEntry, line: number, left: number, right: number): string {
  return entry.folded.length === entry.text.length
    ? entry.text.slice(left, right)
    : trimmedLine(entry.text, line)
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

  const entryFor = (note: Note): ContentEntry => ({
    note,
    text: note.source,
    folded: foldSearchText(note.source),
    starts: undefined,
  })

  // Notes keep their object identity across scans, so an edit updates the entry in
  // place instead of copying the whole index.
  const refresh = (entry: ContentEntry, note: Note): ContentEntry => {
    if (entry.text !== note.source) {
      entry.text = note.source
      entry.folded = foldSearchText(note.source)
      entry.starts = undefined
    }
    entry.note = note
    return entry
  }

  const patch = (current: ContentEntry[], next: readonly Note[]): ContentEntry[] => {
    const sameOrder =
      next.length === current.length && next.every((note, i) => note.path === current[i].note.path)
    if (sameOrder) {
      for (let index = 0; index < next.length; index++) refresh(current[index], next[index])
      return current
    }
    const byPath = new Map(current.map((entry) => [entry.note.path, entry]))
    return next.map((note) => {
      const existing = byPath.get(note.path)
      return existing ? refresh(existing, note) : entryFor(note)
    })
  }

  const indexContent = async (snapshot: readonly Note[], builtVersion: number) => {
    const built: ContentEntry[] = []
    const pause = searchBudget()
    let size = 0
    for (const note of snapshot) {
      const source = note.source
      built.push({ note, text: source, folded: foldSearchText(source), starts: undefined })
      size += source.length
      if ((built.length & 63) === 0) await pause()
    } // A large note can fold inside one budget slice, so always let timers run once.
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
    const add = (
      note: Note,
      text: string,
      line: number | undefined,
      rank: number,
      score: number,
      start: number
    ) => {
      const length = text.length
      const previous = found.get(note.path)
      if (
        previous &&
        (previous.rank < rank ||
          (previous.rank === rank &&
            (previous.score > score || (previous.score === score && previous.length <= length))))
      )
        return
      const result: SearchResult = { note }
      if (line !== undefined) {
        const literal = text.toLowerCase().indexOf(lower)
        const from = Math.max(0, (literal >= 0 ? literal : start) - 50)
        result.line = line
        result.snippet = `${from ? '…' : ''}${text.slice(from, from + 180)}${text.length > from + 180 ? '…' : ''}`
      }
      found.set(note.path, { result, rank, score, length })
    }

    if (mode !== 'content') {
      for (const { item, score, start } of names.find(value))
        add(item.note, item.text, undefined, item.folded.includes(folded) ? 0 : 2, score, start)
    }
    if (mode !== 'names') {
      if (!content) content = indexContent(notes, version)
      const currentEntries = await content
      for (const entry of currentEntries) {
        if (current !== request || cancelled()) return []
        // Nothing in the content can outrank a name hit for the same note.
        if (found.get(entry.note.path)?.rank !== 0) {
          const foldedText = entry.folded
          let literal = -1
          let literalAt = 0
          let bestLine = 0
          let bestLeft = 0
          let bestRight = 0
          let at = foldedText.indexOf(folded)
          if (at >= 0) {
            const starts = lineOffsets(entry)
            let line = 0
            while (at >= 0) {
              while (line + 1 < starts.length && starts[line + 1] <= at) line++
              const lineStart = starts[line]
              const end = line + 1 < starts.length ? starts[line + 1] - 1 : foldedText.length
              let left = lineStart
              while (left < end && isSpace(foldedText.charCodeAt(left))) left++
              let right = end
              while (right > left && isSpace(foldedText.charCodeAt(right - 1))) right--
              if (at >= left && at + folded.length <= right) {
                const score = literalScore(
                  right - left,
                  right - left === folded.length,
                  at - left,
                  at === left || isBoundary(foldedText, at)
                )
                if (literal < 0 || score > literal) {
                  literal = score
                  literalAt = at
                  bestLine = line
                  bestLeft = left
                  bestRight = right
                }
              }
              at = foldedText.indexOf(folded, end + 1)
            }
          }
          if (literal >= 0)
            add(
              entry.note,
              lineText(entry, bestLine, bestLeft, bestRight),
              bestLine + 1,
              1,
              literal,
              literalAt - bestLeft
            )
          else if (containsAll(foldedText, folded)) {
            const starts = lineOffsets(entry)
            let fuzzy = -Infinity
            let fuzzyLength = 0
            for (let line = 0; line < starts.length; line++) {
              const lineStart = starts[line]
              const end = line + 1 < starts.length ? starts[line + 1] - 1 : foldedText.length
              let left = lineStart
              while (left < end && isSpace(foldedText.charCodeAt(left))) left++
              let right = end
              while (right > left && isSpace(foldedText.charCodeAt(right - 1))) right--
              if (right > left) {
                const score = fuzzyScoreInRange(foldedText, folded, left, right)
                const length = right - left
                if (score > fuzzy || (score === fuzzy && length < fuzzyLength)) {
                  fuzzy = score
                  fuzzyLength = length
                  bestLine = line
                  bestLeft = left
                  bestRight = right
                }
              }
            }
            if (fuzzy > -Infinity)
              add(
                entry.note,
                lineText(entry, bestLine, bestLeft, bestRight),
                bestLine + 1,
                3,
                fuzzy,
                foldedText.indexOf(folded[0], bestLeft) - bestLeft
              )
          }
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
