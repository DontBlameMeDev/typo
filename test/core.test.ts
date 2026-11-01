import { describe, expect, test } from 'bun:test'
import { buildNoteSource, extractTitle, noteFilename, searchNotes } from '../src/core'
import type { Note } from '../src/types'

const note = (path: string, source: string): Note => ({
  path,
  uri: `content://test/${path}`,
  title: extractTitle(source, path),
  source,
  modifiedAt: null,
})
const notes = [
  note('atomic_notes.typ', '#title[Atomic Notes]\nOne concept per note.\nUse LEGO bricks.'),
  note('uni/math/binary_search.typ', '#title[Binary Search]\nSearch a sorted list.'),
  note('writing.typ', '#title[Writing]\nBuild a concept from LEGO bricks.'),
]

describe('vault naming and templates', () => {
  test('matches the desktop filename convention', () => {
    expect(noteFilename('  Atomic Notes  ')).toBe('atomic_notes.typ')
    expect(noteFilename('Über das Lernen')).toBe('über_das_lernen.typ')
    expect(noteFilename('Example.typ')).toBe('example.typ')
  })
  test('rejects unsafe or empty filenames', () => {
    for (const title of [
      '',
      '  ',
      '../secret',
      'uni/math',
      'a\\b',
      '.hidden',
      'bad\nname',
      'trailing.',
    ]) {
      expect(() => noteFilename(title)).toThrow()
    }
    expect(() => noteFilename('a'.repeat(181))).toThrow()
  })
  test('uses the existing template and escapes title markup', () => {
    const source = buildNoteSource('A [small] #note', 'Body.\n\n')
    expect(source).toBe(
      '#import "style/lib.typ": *\n#show: template\n\n#title[A \\[small\\] \\#note]\n\nBody.\n'
    )
    expect(extractTitle(source, 'fallback.typ')).toBe('A [small] #note')
  })
  test('extracts nested and multiline titles without treating code as metadata', () => {
    expect(extractTitle('#title[An [inner] title]', 'other.typ')).toBe('An [inner] title')
    expect(extractTitle('#title[Several\n lines]', 'other.typ')).toBe('Several lines')
    expect(extractTitle('Body only', 'my_note.typ')).toBe('my note')
    expect(extractTitle('#title[Unclosed', 'my_note.typ')).toBe('my note')
  })
})

describe('search', () => {
  test('returns all notes for an empty query', () => {
    expect(searchNotes(notes, '  ', 'all').length).toBe(3)
  })
  test('uses fzf for abbreviated names and nested paths', () => {
    expect(searchNotes(notes, 'atnts', 'names')[0].note.path).toBe('atomic_notes.typ')
    expect(searchNotes(notes, 'uni/math', 'names')[0].note.path).toBe('uni/math/binary_search.typ')
  })
  test('finds literal text case-insensitively with a line number', () => {
    const results = searchNotes(notes, 'LEGO', 'content')
    expect(results.map((result) => result.note.path)).toEqual(['atomic_notes.typ', 'writing.typ'])
    expect(results[0].line).toBe(3)
    expect(results[0].snippet).toBe('Use LEGO bricks.')
  })
  test('does not duplicate filename and content results', () => {
    const results = searchNotes(notes, 'concept', 'all')
    expect(results.length).toBe(2)
    expect(new Set(results.map((result) => result.note.path)).size).toBe(2)
    expect(
      searchNotes(notes, 'atomic', 'all').filter(
        (result) => result.note.path === 'atomic_notes.typ'
      ).length
    ).toBe(1)
  })
  test('does not interpret content queries as regular expressions', () => {
    expect(searchNotes(notes, '.*', 'content')).toEqual([])
    expect(searchNotes(notes, 'no match', 'all')).toEqual([])
  })
})
