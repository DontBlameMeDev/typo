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

type FolderRows = { notes: Note[]; sort: NoteSort; rows: NoteRowItem[] }

export type FolderRowsCache = Map<string, FolderRows>

// Reuses the previous rows while a folder's notes are unchanged, so toggling a
// favorite or running a search does not re-sort the folder.
export function sortedNoteRows(
  cache: FolderRowsCache,
  key: string,
  notes: Note[],
  sort: NoteSort
): NoteRowItem[] {
  const cached = cache.get(key)
  if (cached && cached.sort === sort && sameNotes(cached.notes, notes)) {
    cached.notes = notes
    return cached.rows
  }
  const rows = sortNotes(notes, sort).map((note) => noteRow(noteResult(note)))
  cache.set(key, { notes, sort, rows })
  return rows
}

function sameNotes(previous: Note[], next: Note[]): boolean {
  if (previous.length !== next.length) return false
  for (let index = 0; index < next.length; index++)
    if (previous[index] !== next[index]) return false
  return true
}
