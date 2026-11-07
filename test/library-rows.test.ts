import { describe, expect, test } from 'bun:test'
import { sortNotes } from '../src/core'
import { type FolderRowsCache, noteRow, sortedNoteRows } from '../src/library-rows'
import type { Note, SearchResult, Vault } from '../src/types'

const vault: Vault = { uri: 'content://vault', name: 'Vault' }

function note(path: string, title: string, modifiedAt = 0): Note {
  return { path, uri: `${vault.uri}/document/${path}`, title, source: '', modifiedAt }
}

function cache(): FolderRowsCache {
  return new Map()
}

describe('noteRow', () => {
  test('returns the same row while the result is unchanged', () => {
    const result: SearchResult = { note: note('a.typ', 'A') }
    expect(noteRow(result)).toBe(noteRow(result))
  })

  test('returns a new row for a new result', () => {
    const result: SearchResult = { note: note('a.typ', 'A') }
    const changed: SearchResult = { note: note('a.typ', 'A', 1) }
    expect(noteRow(changed)).not.toBe(noteRow(result))
    expect(noteRow(changed).result).toBe(changed)
  })
})

describe('sortedNoteRows', () => {
  test('sorts like sortNotes and keeps row identity', () => {
    const notes = [note('b.typ', 'Beta'), note('a.typ', 'Alpha')]
    const rows = sortedNoteRows(cache(), '', notes, 'name-asc')
    expect(rows.map((row) => row.result.note.title)).toEqual(
      sortNotes(notes, 'name-asc').map((entry) => entry.title)
    )
    const again = sortedNoteRows(cache(), '', notes, 'name-asc')
    expect(again[0]).toBe(rows[0])
    expect(again[1]).toBe(rows[1])
  })

  test('reuses the sorted rows when the note objects did not change', () => {
    const rows = cache()
    const notes = [note('a.typ', 'Alpha'), note('b.typ', 'Beta')]
    const first = sortedNoteRows(rows, '', notes, 'name-asc')
    // An unrelated library change rebuilds the arrays but keeps every note object.
    const second = sortedNoteRows(rows, '', [...notes], 'name-asc')
    expect(second).toBe(first)
  })

  test('re-sorts when a note changed and keeps the other rows', () => {
    const rows = cache()
    const stable = note('a.typ', 'Alpha')
    const first = sortedNoteRows(rows, '', [stable, note('b.typ', 'Beta')], 'name-asc')
    const second = sortedNoteRows(rows, '', [stable, note('b.typ', 'Aardvark')], 'name-asc')
    expect(second).not.toBe(first)
    expect(second.map((row) => row.result.note.title)).toEqual(['Aardvark', 'Alpha'])
    expect(second[1]).toBe(first[0])
  })

  test('re-sorts when only the order of the same notes changed', () => {
    const rows = cache()
    const [first, second] = [note('a.typ', 'Alpha'), note('b.typ', 'Beta')]
    sortedNoteRows(rows, '', [second, first], 'name-asc')
    const sorted = sortedNoteRows(rows, '', [first, second], 'name-asc')
    expect(sorted.map((row) => row.result.note.title)).toEqual(['Alpha', 'Beta'])
  })

  test('caches each folder separately and follows the sort order', () => {
    const rows = cache()
    const root = [note('a.typ', 'Alpha', 1), note('b.typ', 'Beta', 2)]
    sortedNoteRows(rows, '', root, 'name-asc')
    expect(sortedNoteRows(rows, 'notes', [note('n.typ', 'Note')], 'name-asc')).toHaveLength(1)
    expect(
      sortedNoteRows(rows, '', root, 'modified-desc').map((row) => row.result.note.title)
    ).toEqual(['Beta', 'Alpha'])
  })
})
