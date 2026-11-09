import { type NoteSort, sortNotes } from './core'
import type { Note, SearchResult } from './types'

export type NoteRowItem = { kind: 'note'; result: SearchResult }
export type FolderRowItem = { kind: 'folder'; path: string; name: string }
export type LibraryItem = NoteRowItem | FolderRowItem

const noteResults = new WeakMap<Note, SearchResult>()
const noteRows = new WeakMap<SearchResult, NoteRowItem>()

function noteResult(note: Note): SearchResult {
  let result = noteResults.get(note)
  if (!result) {
    result = { note }
    noteResults.set(note, result)
  }
  return result
}

// Rows keep their identity while their note does, so an edited source does not
// recreate every row and FlatList can skip cells that did not change.
export function noteRow(result: SearchResult): NoteRowItem {
  let row = noteRows.get(result)
  if (!row) {
    row = { kind: 'note', result }
    noteRows.set(result, row)
  }
  return row
}

type FolderRows = { notes: Note[]; rows: Map<NoteSort, NoteRowItem[]> }

export type FolderRowsCache = Map<string, FolderRows>

function rowsFor(notes: Note[], sort: NoteSort): NoteRowItem[] {
  return sortNotes(notes, sort).map((note) => noteRow(noteResult(note)))
}

// Reuses the previous rows while a folder's notes are unchanged, so toggling a
// favorite or running a search does not re-sort the folder. Every order is kept,
// so switching back to one already shown is free.
export function sortedNoteRows(
  cache: FolderRowsCache,
  key: string,
  notes: Note[],
  sort: NoteSort
): NoteRowItem[] {
  const cached = cache.get(key)
  if (cached && sameNotes(cached.notes, notes)) {
    cached.notes = notes
    const rows = cached.rows.get(sort)
    if (rows) return rows
    if (sort === 'name-desc') {
      const ascending = cached.rows.get('name-asc')
      if (ascending) {
        const descending = ascending.slice().reverse()
        cached.rows.set('name-desc', descending)
        return descending
      }
    }
    const computed = rowsFor(notes, sort)
    cached.rows.set(sort, computed)
    return computed
  }
  const rows: Map<NoteSort, NoteRowItem[]> = new Map()
  const sorted = rowsFor(notes, sort)
  rows.set(sort, sorted)
  cache.set(key, { notes, rows })
  return sorted
}

function sameNotes(previous: Note[], next: Note[]): boolean {
  if (previous.length !== next.length) return false
  for (let index = 0; index < next.length; index++)
    if (previous[index] !== next[index]) return false
  return true
}
