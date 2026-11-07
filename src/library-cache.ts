import * as FileSystem from 'expo-file-system/legacy'
import { fingerprint } from './compiler/fingerprint'
import { type NoteSort, sortNotes } from './core'
import type { Note, SearchResult, Vault } from './types'

function location(vault: Vault) {
  if (!FileSystem.cacheDirectory) throw new Error('Private cache storage is unavailable.')
  const directory = `${FileSystem.cacheDirectory}typo-library/`
  return { directory, uri: `${directory}${fingerprint(vault.uri)}.json` }
}

export async function loadVaultIndex(vault: Vault): Promise<Note[] | null> {
  try {
    const value = JSON.parse(await FileSystem.readAsStringAsync(location(vault).uri))
    if (value.version !== 2 || value.vault !== vault.uri || !Array.isArray(value.notes)) return null
    if (
      !value.notes.every(
        (note: Note) =>
          note &&
          typeof note.path === 'string' &&
          typeof note.uri === 'string' &&
          note.uri.startsWith(`${vault.uri}/document/`) &&
          typeof note.source === 'string' &&
          typeof note.title === 'string'
      )
    )
      return null
    return value.notes
  } catch {
    return null
  }
}

export async function storeVaultIndex(vault: Vault, notes: Note[]): Promise<void> {
  const { directory, uri } = location(vault)
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
  await FileSystem.writeAsStringAsync(uri, JSON.stringify({ version: 2, vault: vault.uri, notes }))
}

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
