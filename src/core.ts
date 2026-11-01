import { Fzf } from 'fzf'
import type { Note, SearchMode, SearchResult } from './types'

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

export function buildNoteSource(title: string, body: string): string {
  noteFilename(title)
  const escaped = title.trim().replace(/[\\#[\]*_$@<>`~]/gu, '\\$&')
  return `#import "style/lib.typ": *\n#show: template\n\n#title[${escaped}]\n\n${body.trimEnd()}\n`
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
