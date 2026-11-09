import { describe, expect, test } from 'bun:test'
import { parseVaultIndex, serializeVaultIndex } from '../src/library-index'
import type { Note, Vault } from '../src/types'

const vault: Vault = {
  uri: 'content://com.android.externalstorage.documents/tree/primary%3AVault',
  name: 'Vault',
}

function note(path: string, source = '#title[Note]\n'): Note {
  return {
    uri: `${vault.uri}/document/${encodeURIComponent(`primary:Vault/${path}`)}`,
    path,
    title: 'Note',
    source,
    modifiedAt: 1,
  }
}

describe('vault index', () => {
  test('round trips notes with their sources and PDF metadata', () => {
    const notes = [
      note('a.typ', '#title[A]'),
      { ...note('b.typ', '#title[B]'), pdfUri: 'content://pdf', pdfHash: 'abc' },
    ]
    expect(parseVaultIndex(serializeVaultIndex(vault, notes), vault)).toEqual(notes)
  })

  test('rejects another format version or vault', () => {
    const text = serializeVaultIndex(vault, [note('a.typ')])
    expect(parseVaultIndex(text.replace('"version":2', '"version":1'), vault)).toBeNull()
    expect(parseVaultIndex(text, { ...vault, uri: `${vault.uri}/other` })).toBeNull()
  })

  test('rejects notes from another vault and malformed entries', () => {
    const foreign = { ...note('a.typ'), uri: 'content://other/document/a.typ' }
    expect(
      parseVaultIndex(JSON.stringify({ version: 2, vault: vault.uri, notes: [foreign] }), vault)
    ).toBeNull()
    expect(
      parseVaultIndex(
        JSON.stringify({ version: 2, vault: vault.uri, notes: [{ ...note('a.typ'), source: 1 }] }),
        vault
      )
    ).toBeNull()
    expect(
      parseVaultIndex(JSON.stringify({ version: 2, vault: vault.uri, notes: null }), vault)
    ).toBeNull()
  })

  test('rejects invalid JSON and an empty library', () => {
    expect(parseVaultIndex('not JSON', vault)).toBeNull()
    expect(parseVaultIndex(serializeVaultIndex(vault, []), vault)).toEqual([])
  })
})
