import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_TEMPLATES,
  buildNoteSource,
  createNoteSearch,
  extractTitle,
  foldersFromNotes,
  noteFilename,
  reconcileNotes,
} from '../src/core'
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
  test('applies portable templates with an escaped title, raw body, and one substitution pass', () => {
    const template = 'TITLE: {{title}}\n---\n{{body}}\n'
    const source = buildNoteSource('A [small] #note', 'Raw {{title}} and {{body}}', template)
    expect(source).toBe('TITLE: A \\[small\\] \\#note\n---\nRaw {{title}} and {{body}}\n')
    expect(buildNoteSource('{{body}}', 'Text {{title}}', '{{title}}\n{{body}}')).toBe(
      '{{body}}\nText {{title}}'
    )
  })
  test('requires a title field and rejects unknown placeholders', () => {
    expect(() => buildNoteSource('Title', 'Body', 'No fields here')).toThrow(
      'must include {{title}}'
    )
    expect(() => buildNoteSource('Title', 'Body', '{{title}} {{date}}')).toThrow(
      'unknown placeholder {{date}}'
    )
    expect(buildNoteSource('Title', 'Body', '{{title}}')).toBe('Title')
  })
  test('ships a standalone plain template without the classic style import', () => {
    expect(BUILTIN_TEMPLATES.map((template) => template.id)).toEqual(['builtin:plain'])
    const source = buildNoteSource('Plain title', 'Plain body', BUILTIN_TEMPLATES[0].source)
    expect(source).not.toContain('style/lib.typ')
    expect(source).toContain('#set page(margin: 2.5cm)')
    expect(source).toContain('Plain title')
    expect(extractTitle(source, 'plain_title.typ')).toBe('Plain title')
    expect(source).toContain('Plain body')
  })
  test('derives every browsable parent folder from note paths', () => {
    expect(foldersFromNotes(notes)).toEqual(['', 'uni', 'uni/math'])
    expect(foldersFromNotes([])).toEqual([''])
    expect(foldersFromNotes([note('a/b/c/deep.typ', '#title[Deep]')])).toEqual([
      '',
      'a',
      'a/b',
      'a/b/c',
    ])
  })
  test('extracts nested and multiline titles without treating code as metadata', () => {
    expect(extractTitle('#title[An [inner] title]', 'other.typ')).toBe('An [inner] title')
    expect(extractTitle('#title[Several\n lines]', 'other.typ')).toBe('Several lines')
    expect(extractTitle('Body only', 'my_note.typ')).toBe('my note')
    expect(extractTitle('#title[Unclosed', 'my_note.typ')).toBe('my note')
  })
})

describe('index refresh', () => {
  test('keeps unchanged notes and the index stable across scans', () => {
    expect(
      reconcileNotes(
        notes,
        notes.map((item) => ({ ...item }))
      )
    ).toBe(notes)
  })

  test('indexes created, changed, and deleted notes without replacing unchanged rows', () => {
    const added = note('new_note.typ', '#title[New note]\nFresh text')
    const changed = note(notes[1].path, '#title[Changed]\nExternal text')
    const result = reconcileNotes(notes, [{ ...notes[0] }, changed, added])
    expect(result).not.toBe(notes)
    expect(result[0]).toBe(notes[0])
    expect(result[1]).toBe(changed)
    const search = createNoteSearch(result)
    expect(search('Fresh text', 'content')[0].note).toBe(added)
    expect(search('writing', 'names')).toEqual([])
    expect(search('External text', 'content')[0].note).toBe(changed)
  })

  test('keeps updated PDF links and paths from the scan', () => {
    const updated = { ...notes[0], pdfUri: 'content://test/out/atomic_notes.pdf' }
    expect(reconcileNotes(notes, [updated, ...notes.slice(1)])[0]).toBe(updated)
    const moved = { ...notes[0], path: 'other.typ' }
    expect(reconcileNotes(notes, [moved, ...notes.slice(1)])[0]).toBe(moved)
  })
})

describe('search', () => {
  const searchNotes = (items: Note[], query: string, mode: 'all' | 'names' | 'content') =>
    createNoteSearch(items)(query, mode)
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
  test('matches abbreviated content with its original line and snippet', () => {
    const results = searchNotes(notes, 'lgbr', 'content')
    expect(results.map((result) => result.note.path)).toEqual(['atomic_notes.typ', 'writing.typ'])
    expect(results[0].line).toBe(3)
    expect(results[0].snippet).toBe('Use LEGO bricks.')
  })
  test('ignores query case and accents in names and content', () => {
    const items = [note('cafe.typ', '#title[Café Notes]\nÜber das Lernen.')]
    expect(searchNotes(items, 'CAFE', 'names')[0].note).toBe(items[0])
    expect(searchNotes(items, 'UBER', 'content')[0].line).toBe(2)
    expect(searchNotes(notes, 'ATNTS', 'names')[0].note.path).toBe('atomic_notes.typ')
  })
  test('ranks literal matches before fuzzy matches across modes', () => {
    const items = [
      note('loose.typ', '#title[Loud Evening Golden Oranges]'),
      note('body.typ', '#title[Body]\nLEGO bricks.'),
      note('lego.typ', '#title[LEGO]'),
    ]
    expect(searchNotes(items, 'lego', 'all').map((result) => result.note.path)).toEqual([
      'lego.typ',
      'body.typ',
      'loose.typ',
    ])
    expect(searchNotes(items, 'lego', 'names').map((result) => result.note.path)).toEqual([
      'lego.typ',
      'loose.typ',
    ])
  })
  test('uses the best matching content line, preferring literal text', () => {
    const items = [
      note('body.typ', '#title[Body]\nLoud Evening Golden Oranges\nSome LEGO bricks.\nLEGO'),
    ]
    const [result] = searchNotes(items, 'lego', 'content')
    expect(result.line).toBe(4)
    expect(result.snippet).toBe('LEGO')
  })
  test('does not match across source lines or join title and path', () => {
    const items = [note('ending.typ', '#title[Beginning]\nalpha\nbeta')]
    expect(searchNotes(items, 'alphabeta', 'content')).toEqual([])
    expect(searchNotes(items, 'Beginningending', 'names')).toEqual([])
  })
  test('keeps long snippets centered near the match with Unicode offsets', () => {
    const items = [note('long.typ', `${'😀'.repeat(150)}LEGO${'x'.repeat(200)}`)]
    const [result] = searchNotes(items, 'lego', 'content')
    expect(result.line).toBe(1)
    expect(result.snippet).toStartWith('…')
    expect(result.snippet).toContain('LEGO')
    expect(result.snippet).toEndWith('…')
  })
  test('builds the content index lazily and reuses it across queries and modes', () => {
    let reads = 0
    const item = {
      ...notes[0],
      get source() {
        reads++
        return notes[0].source
      },
    }
    const search = createNoteSearch([item])
    search('atomic', 'names')
    search('', 'all')
    expect(reads).toBe(0)
    search('LEGO', 'content')
    search('lgbr', 'all')
    search('concept', 'content')
    expect(reads).toBe(1)
  })
  test('a new index reflects edited and removed notes', () => {
    const original = createNoteSearch(notes)
    expect(original('lego', 'content')).toHaveLength(2)
    const edited = note('atomic_notes.typ', '#title[Changed]\nReplacement text.')
    const refreshed = createNoteSearch([edited])
    expect(refreshed('lego', 'all')).toEqual([])
    expect(refreshed('replacement', 'content')[0].note).toBe(edited)
    expect(refreshed('', 'all').map((result) => result.note)).toEqual([edited])
  })
  test('does not interpret content queries as regular expressions', () => {
    expect(searchNotes(notes, '.*', 'content')).toEqual([])
    expect(searchNotes(notes, 'no match', 'all')).toEqual([])
  })
})
