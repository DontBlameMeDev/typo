import { beforeEach, expect, mock, test } from 'bun:test'
import type { Note } from '../src/types'

type File = { source: string; modificationTime?: number }
const root = 'content://com.android.externalstorage.documents/tree/primary%3AVault'
const vault = { uri: root, name: 'Vault' }
const files = new Map<string, File>()
const directories = new Map<string, string[]>()
const unreadable = new Set<string>()
let granted = true
let permissionError: Error | undefined
let readCount = 0
let maximumReads = 0
let createResult: string | undefined
let copyError: Error | undefined
let pickerUri = root
let handlesClosed = 0
let handleWriteError: Error | undefined

function uriFor(path: string): string {
  return `${root}/document/${encodeURIComponent(`primary:Vault/${path}`)}`
}

function addDirectory(path: string, parent = root): string {
  const uri = uriFor(path)
  directories.set(uri, [])
  directories.get(parent)?.push(uri)
  return uri
}

function addFile(path: string, source = '#title[Test]\n', parent = root): string {
  const uri = uriFor(path)
  files.set(uri, { source, modificationTime: 123 })
  directories.get(parent)?.push(uri)
  return uri
}

const getInfoAsync = mock(async (uri: string) => {
  if (directories.has(uri)) {
    return { exists: false, isDirectory: false }
  }
  const file = files.get(uri)
  return file
    ? { exists: true, isDirectory: false, modificationTime: file.modificationTime }
    : { exists: false, isDirectory: false }
})
const readAsStringAsync = mock(async (uri: string) => {
  readCount++
  maximumReads = Math.max(maximumReads, readCount)
  try {
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (unreadable.has(uri)) throw new Error('Read permission denied')
    const file = files.get(uri)
    if (!file) throw new Error('No such file')
    return file.source
  } finally {
    readCount--
  }
})
const writeAsStringAsync = mock(async (uri: string, source: string) => {
  files.set(uri, { source })
})
const deleteAsync = mock(async (uri: string) => {
  files.delete(uri)
})
const readDirectoryAsync = mock(async (uri: string) => {
  if (unreadable.has(uri)) throw new Error('Directory access denied')
  const children = directories.get(uri)
  if (!children) throw new Error('No such directory')
  return [...children]
})
const createFileAsync = mock(async (_parent: string, name: string, _mime: string) => {
  if (createResult) return createResult
  return addFile(name, '')
})
const copyAsync = mock(async ({ from, to }: { from: string; to: string }) => {
  if (copyError) {
    files.set(to, { source: 'partial copy' })
    throw copyError
  }
  const file = files.get(from)
  if (!file) throw new Error('PDF missing')
  files.set(to, { ...file })
})
const makeDirectoryAsync = mock(async (uri: string) => {
  if (!directories.has(uri)) directories.set(uri, [])
})

mock.module('expo-file-system', () => ({
  FileMode: { Truncate: 'wt' },
  File: class {
    constructor(private uri: string) {}
    async bytes() {
      return new TextEncoder().encode(files.get(this.uri)?.source || '')
    }
    open(mode: string) {
      expect(mode).toBe('wt')
      files.set(this.uri, { source: '' })
      return {
        writeBytes: async (bytes: Uint8Array) => {
          if (handleWriteError) throw handleWriteError
          files.set(this.uri, { source: new TextDecoder().decode(bytes) })
        },
        close: () => {
          handlesClosed++
        },
      }
    }
    info() {
      const file = files.get(this.uri)
      return file
        ? {
            exists: true,
            modificationTime:
              file.modificationTime === undefined ? undefined : file.modificationTime * 1000,
          }
        : { exists: false }
    }
  },
  Directory: class {
    constructor(private uri: string) {}
    get exists() {
      return directories.has(this.uri)
    }
  },
}))
mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///private/documents/',
  cacheDirectory: 'file:///private/cache/',
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
  deleteAsync,
  copyAsync,
  makeDirectoryAsync,
  readDirectoryAsync: async (directory: string) =>
    [...files.keys()]
      .filter((uri) => uri.startsWith(directory))
      .map((uri) => uri.slice(directory.length)),
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: async () => {
      if (permissionError) throw permissionError
      return granted ? { granted: true, directoryUri: pickerUri } : { granted: false }
    },
    readDirectoryAsync,
    createFileAsync,
  },
}))

const {
  pickVault,
  loadSavedVault,
  forgetVault,
  scanVault,
  createNote,
  saveNote,
  preparePdf,
  releasePdf,
} = await import('../src/vault')

beforeEach(() => {
  files.clear()
  directories.clear()
  directories.set(root, [])
  unreadable.clear()
  granted = true
  permissionError = undefined
  readCount = 0
  maximumReads = 0
  createResult = undefined
  copyError = undefined
  pickerUri = root
  handlesClosed = 0
  handleWriteError = undefined
  for (const fn of [
    getInfoAsync,
    readAsStringAsync,
    writeAsStringAsync,
    deleteAsync,
    readDirectoryAsync,
    createFileAsync,
    copyAsync,
    makeDirectoryAsync,
  ])
    fn.mockClear()
})

test('selection persists only URI/name in private documents and loads with access validation', async () => {
  expect(await loadSavedVault()).toBeNull()
  expect(await pickVault()).toEqual(vault)
  expect(writeAsStringAsync).toHaveBeenCalledWith(
    'file:///private/documents/typo-vault.json',
    JSON.stringify(vault)
  )
  expect(await loadSavedVault()).toEqual(vault)
  expect(readDirectoryAsync).toHaveBeenCalledWith(root)
})

test('picker cancellation preserves selection while real picker errors propagate', async () => {
  await pickVault()
  granted = false
  expect(await pickVault()).toBeNull()
  expect(await loadSavedVault()).toEqual(vault)
  permissionError = new Error('Picker unavailable')
  await expect(pickVault()).rejects.toThrow('Picker unavailable')
})

test('forget deletes only the private selection, never the vault', async () => {
  await pickVault()
  const uri = addFile('existing.typ')
  await forgetVault()
  expect(await loadSavedVault()).toBeNull()
  expect(files.has(uri)).toBe(true)
  expect(deleteAsync).toHaveBeenCalledWith('file:///private/documents/typo-vault.json', {
    idempotent: true,
  })
})

test('corrupt selections and revoked access are visible errors rather than empty vaults', async () => {
  files.set('file:///private/documents/typo-vault.json', { source: 'not JSON' })
  await expect(loadSavedVault()).rejects.toThrow('Cannot load the saved vault')
  files.set('file:///private/documents/typo-vault.json', {
    source: JSON.stringify({ uri: 'file:///external/', name: 'Invalid' }),
  })
  await expect(loadSavedVault()).rejects.toThrow('invalid')
  await pickVault()
  unreadable.add(root)
  await expect(loadSavedVault()).rejects.toThrow('Choose the folder again')
})

test('scan uses actual enumerated URIs, skips infrastructure, and matches nested PDFs by path', async () => {
  const main = addFile('hello_world.typ', '#title[Hello world]\nBody')
  const nested = addDirectory('nested')
  const sub = addFile('nested/deep.typ', '#title[Deep]\nBody', nested)
  const output = addDirectory('out')
  const mainPdf = addFile('out/hello_world.pdf', 'binary PDF', output)
  const outputNested = addDirectory('out/nested', output)
  const deepPdf = addFile('out/nested/deep.pdf', 'binary PDF', outputNested)
  addFile('out/not_a_note.typ', 'not a source', output)
  for (const name of ['style', 'assets', '.direnv', '.git', '.hidden']) {
    const excluded = addDirectory(name)
    addFile(`${name}/ignored.typ`, '#title[Ignored]', excluded)
    unreadable.add(excluded)
  }
  addFile('readme.md', 'not a note')
  const progress: number[] = []
  const notes = await scanVault(vault, (count) => progress.push(count))
  expect(
    notes.map(({ path, uri, title, pdfUri, modifiedAt }) => ({
      path,
      uri,
      title,
      pdfUri,
      modifiedAt,
    }))
  ).toEqual([
    {
      path: 'hello_world.typ',
      uri: main,
      title: 'Hello world',
      pdfUri: mainPdf,
      modifiedAt: 123000,
    },
    { path: 'nested/deep.typ', uri: sub, title: 'Deep', pdfUri: deepPdf, modifiedAt: 123000 },
  ])
  expect(progress).toEqual([1, 2])
  expect(readAsStringAsync.mock.calls.map(([uri]) => uri).sort()).toEqual([main, sub].sort())
  expect(readDirectoryAsync.mock.calls.map(([uri]) => uri)).toEqual([
    root,
    nested,
    output,
    outputNested,
  ])
})

test('scan uses modern metadata for SAF entries without opening legacy content streams', async () => {
  const directory = addDirectory('folder.with.dots')
  const uri = addFile('folder.with.dots/note.typ', 'Body without title', directory)
  files.set(uri, { source: 'Body without title' })
  const [note] = await scanVault(vault)
  expect(note.path).toBe('folder.with.dots/note.typ')
  expect(note.modifiedAt).toBeNull()
  expect(getInfoAsync.mock.calls.some(([uri]) => uri.startsWith('content://'))).toBe(false)
})

test('scan bounds source reads and reports every completed note', async () => {
  for (let index = 0; index < 40; index++) addFile(`note_${index}.typ`)
  const progress: number[] = []
  expect(await scanVault(vault, (count) => progress.push(count))).toHaveLength(40)
  expect(maximumReads).toBeGreaterThan(1)
  expect(maximumReads).toBeLessThanOrEqual(6)
  expect(progress).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
})

test('an unreadable source fails the entire index and drains in-flight work', async () => {
  for (let index = 0; index < 20; index++) addFile(`note_${index}.typ`)
  unreadable.add(uriFor('note_1.typ'))
  await expect(scanVault(vault)).rejects.toThrow('index is incomplete')
  expect(readCount).toBe(0)
  expect(readAsStringAsync.mock.calls.length).toBeLessThan(20)
})

test('unreadable directories and disappearing entries fail indexing visibly', async () => {
  const nested = addDirectory('nested')
  unreadable.add(nested)
  await expect(scanVault(vault)).rejects.toThrow('Directory access denied')
  unreadable.clear()
  directories.get(root)?.push(uriFor('gone.typ'))
  await expect(scanVault(vault)).rejects.toThrow('gone.typ')
})

test('new notes use the root and return provider-created URIs without overwriting existing files', async () => {
  const note = await createNote(vault, 'My Note', 'New body')
  expect(createFileAsync).toHaveBeenCalledWith(root, 'my_note.typ', 'application/octet-stream')
  expect(note.uri).toBe(uriFor('my_note.typ'))
  expect(note.path).toBe('my_note.typ')
  expect(note.title).toBe('My Note')
  expect(note.source).toContain('#import "style/lib.typ": *')
  expect(note.source).toContain('#show: template')
  expect(note.source).toContain('#title[My Note]')
  expect(note.pdfUri).toBeUndefined()
  await expect(createNote(vault, 'My Note', 'Overwrite?')).rejects.toThrow('already exists')
  expect(files.get(note.uri)?.source).toBe(note.source)
  expect(createFileAsync).toHaveBeenCalledTimes(1)
})

test('creation rejects nested directories, traversal, and hidden/unsafe names before creating', async () => {
  for (const directory of ['nested', '../', '/outside', ' ']) {
    await expect(createNote(vault, 'Note', '', directory)).rejects.toThrow('vault root')
  }
  for (const title of ['../outside', '.hidden', 'a\\b', 'a/b', 'a\u0000b', 'a:b']) {
    await expect(createNote(vault, title, '')).rejects.toThrow()
  }
  expect(createFileAsync).not.toHaveBeenCalled()
  expect(writeAsStringAsync).not.toHaveBeenCalled()
})

test('provider renaming or returning an existing URI cannot trigger an overwrite', async () => {
  const existing = addFile('other.typ', 'Existing source')
  createResult = existing
  await expect(createNote(vault, 'New', '')).rejects.toThrow('Nothing was written')
  expect(files.get(existing)?.source).toBe('Existing source')
  expect(writeAsStringAsync).not.toHaveBeenCalled()
})

function noteFor(uri: string, source = '#title[Old]\n'): Note {
  return {
    uri,
    path: 'note.typ',
    title: 'Old',
    source,
    modifiedAt: null,
    pdfUri: uriFor('out/note.pdf'),
  }
}

test('save compares the original source and clears uncertain PDF availability', async () => {
  const uri = addFile('note.typ', '#title[Old]\n')
  const updated = await saveNote(noteFor(uri), '#title[New]\nEdited body')
  expect(updated.title).toBe('New')
  expect(updated.source).toBe('#title[New]\nEdited body')
  expect(updated).not.toHaveProperty('pdfUri')
  expect(files.get(uri)?.source).toBe(updated.source)
})

test('shorter Unicode saves truncate the file, close the handle, and clean staging files', async () => {
  const original = '#title[Old]\nA much longer original body.'
  const uri = addFile('note.typ', original)
  await saveNote(noteFor(uri, original), 'Über 📝\n')
  expect(files.get(uri)?.source).toBe('Über 📝\n')
  expect(handlesClosed).toBe(1)
  expect([...files.keys()].filter((path) => path.includes('typo-save-'))).toHaveLength(0)
})

test('failed writes still close their handle and remove staging files', async () => {
  const uri = addFile('note.typ', '#title[Old]\n')
  handleWriteError = new Error('Storage full')
  await expect(saveNote(noteFor(uri), 'Replacement')).rejects.toThrow('Storage full')
  expect(handlesClosed).toBe(1)
  expect([...files.keys()].filter((path) => path.includes('typo-save-'))).toHaveLength(0)
})

test('save rejects external changes and missing files without writing anything', async () => {
  const uri = addFile('note.typ', 'Syncthing edited this')
  await expect(saveNote(noteFor(uri), 'My edits')).rejects.toThrow('changed outside this editor')
  expect(writeAsStringAsync).not.toHaveBeenCalled()
  expect(files.get(uri)?.source).toBe('Syncthing edited this')
  files.delete(uri)
  await expect(saveNote(noteFor(uri), 'My edits')).rejects.toThrow('No such file')
  expect(writeAsStringAsync).not.toHaveBeenCalled()
})

test('PDF preparation copies binary content to distinct safe local cache URIs', async () => {
  const pdfUri = addFile('out/note.pdf', 'PDF binary bytes')
  const note = { ...noteFor(uriFor('note.typ')), path: '../../unsafe name.typ', pdfUri }
  const [first, second] = await Promise.all([preparePdf(note), preparePdf(note)])
  expect(first).not.toBe(second)
  for (const destination of [first, second]) {
    expect(destination).toMatch(
      /^file:\/\/\/private\/cache\/typo-pdfs\/note-[a-z0-9]+-[a-z0-9]+\.pdf$/u
    )
    expect(files.get(destination)?.source).toBe('PDF binary bytes')
    expect(copyAsync).toHaveBeenCalledWith({ from: pdfUri, to: destination })
  }
  expect(readAsStringAsync).not.toHaveBeenCalled()
})

test('missing or failed PDFs are visible errors, not fabricated viewer paths', async () => {
  const note = noteFor(uriFor('note.typ'))
  delete note.pdfUri
  await expect(preparePdf(note)).rejects.toThrow('No current PDF')
  note.pdfUri = uriFor('out/note.pdf')
  copyError = new Error('Provider unavailable')
  await expect(preparePdf(note)).rejects.toThrow('Provider unavailable')
  expect([...files.keys()].filter((uri) => uri.startsWith('file:///private/cache/'))).toHaveLength(
    0
  )
})

test('unsupported document providers are rejected before replacing the saved folder', async () => {
  await pickVault()
  pickerUri = 'content://opaque.documents/tree/folder123'
  await expect(pickVault()).rejects.toThrow('Internal storage')
  expect(await loadSavedVault()).toEqual(vault)
})

test('PDF cache is bounded and viewer cleanup cannot delete vault files', async () => {
  const pdfUri = addFile('out/note.pdf', 'PDF bytes')
  const note = { ...noteFor(uriFor('note.typ')), pdfUri }
  let last = ''
  for (let index = 0; index < 30; index++) last = await preparePdf(note)
  expect(
    [...files.keys()].filter((uri) => uri.startsWith('file:///private/cache/')).length
  ).toBeLessThanOrEqual(24)
  await releasePdf(last)
  expect(files.has(last)).toBe(false)
  await releasePdf(pdfUri)
  expect(files.has(pdfUri)).toBe(true)
})
