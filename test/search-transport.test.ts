import { expect, test } from 'bun:test'
import { SearchTransport } from '../src/search/protocol'
import type { Note } from '../src/types'

const note: Note = {
  uri: 'content://one',
  path: 'one.typ',
  title: 'One',
  source: '= One',
  modifiedAt: null,
}

test('search sends source once and sends only queries on subsequent keystrokes', () => {
  const transport = new SearchTransport()
  expect(transport.request([note], 'one', 'all')).toEqual({
    query: 'one',
    mode: 'all',
    updated: [{ path: note.path, title: note.title, source: note.source }],
    removed: [],
  })
  expect(transport.request([note], 'on', 'content')).toEqual({
    query: 'on',
    mode: 'content',
    updated: [],
    removed: [],
  })
  expect(transport.request([note], 'on', 'content')).toBeNull()
})

test('Names requests do not read or transfer note sources', () => {
  const transport = new SearchTransport()
  const metadataOnly = {
    ...note,
    get source(): string {
      throw new Error('Names must not read source')
    },
  }
  expect(transport.request([metadataOnly], 'one', 'names')).toEqual({
    query: 'one',
    mode: 'names',
    updated: [{ path: note.path, title: note.title }],
    removed: [],
  })
  expect(transport.request([metadataOnly], 'on', 'names')?.updated).toEqual([])
})

test('switching from Names to Everywhere hydrates sources once', () => {
  const transport = new SearchTransport()
  transport.request([note], 'one', 'names')
  expect(transport.request([note], 'one', 'all')?.updated).toEqual([
    { path: note.path, title: note.title, source: note.source },
  ])
  expect(transport.request([note], 'on', 'all')?.updated).toEqual([])
  transport.request([note], 'one', 'names')
  expect(transport.request([note], 'one', 'all')?.updated).toEqual([])
})

test('edits while in Names are transferred when Everywhere is next used', () => {
  const transport = new SearchTransport()
  transport.request([note], 'one', 'all')
  const changed = { ...note, title: 'Changed', source: '= Changed' }
  expect(transport.request([changed], 'change', 'names')?.updated).toEqual([
    { path: changed.path, title: changed.title },
  ])
  expect(transport.request([changed], 'change', 'all')?.updated).toEqual([
    { path: changed.path, title: changed.title, source: changed.source },
  ])
})

test('PDF updates and no-op note refreshes do not rebuild the search index', () => {
  const transport = new SearchTransport()
  transport.request([note], 'one', 'all')
  expect(
    transport.request([{ ...note, pdfUri: 'content://pdf', modifiedAt: 42 }], 'one', 'all')
  ).toBeNull()
})

test('search sends edits, title changes, moves, and deleted notes', () => {
  const transport = new SearchTransport()
  transport.request([note], 'one', 'all')
  const changed = { ...note, title: 'Changed', source: '= Changed' }
  expect(transport.request([changed], 'one', 'all')?.updated).toEqual([
    { path: changed.path, title: changed.title, source: changed.source },
  ])
  const moved = { ...changed, path: 'nested/one.typ' }
  expect(transport.request([moved], 'one', 'all')).toEqual({
    query: 'one',
    mode: 'all',
    updated: [{ path: moved.path, title: moved.title, source: moved.source }],
    removed: ['one.typ'],
  })
  expect(transport.request([], '', 'names')?.removed).toEqual(['nested/one.typ'])
})
