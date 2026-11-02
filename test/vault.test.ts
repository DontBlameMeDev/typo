import { beforeEach, expect, mock, test } from 'bun:test'
import type { Note } from '../src/types'

type File = {
  source: string
  modificationTime?: number
  bytes?: Uint8Array
  encoding?: 'base64'
  size?: number
}
const root = 'content://com.android.externalstorage.documents/tree/primary%3AVault'
const vault = { uri: root, name: 'Vault' }
const files = new Map<string, File>()
const directories = new Map<string, string[]>()
const unreadable = new Set<string>()
let granted = true
let permissionError: Error | undefined
let readCount = 0
let maximumReads = 0
let detailedMetadataReads = 0
let createResult: string | undefined
let copyError: Error | undefined
let pickerUri = root
let handlesClosed = 0
let handleWriteError: Error | undefined
let writeFailure: ((uri: string) => boolean) | undefined
let writeFailureError: Error | undefined
let downloadStatus = 200
const downloadedBytes = Bun.gzipSync('archive')

function uriFor(path: string): string {
  return `${root}/document/${encodeURIComponent(`primary:Vault/${path}`)}`
}

function childUri(parent: string, name: string): string {
  const id = decodeURIComponent(parent.slice(parent.lastIndexOf('/') + 1))
  return `${root}/document/${encodeURIComponent(`${id}/${name}`)}`
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

function fileBytes(file: File): Uint8Array {
  return file.bytes ?? new TextEncoder().encode(file.source)
}

const getInfoAsync = mock(async (uri: string) => {
  if (directories.has(uri)) {
    return { exists: true, isDirectory: true }
  }
  const file = files.get(uri)
  return file
    ? {
        exists: true,
        isDirectory: false,
        modificationTime: file.modificationTime,
        size: file.size ?? fileBytes(file).length,
      }
    : { exists: false, isDirectory: false }
})
const readAsStringAsync = mock(
  async (uri: string, options?: { encoding?: string }): Promise<string> => {
    readCount++
    maximumReads = Math.max(maximumReads, readCount)
    try {
      await new Promise((resolve) => setTimeout(resolve, 1))
      if (unreadable.has(uri)) throw new Error('Read permission denied')
      const file = files.get(uri)
      if (!file) throw new Error('No such file')
      if (options?.encoding === 'base64') {
        if (file.bytes) return Buffer.from(file.bytes).toString('base64')
        if (file.encoding === 'base64') return file.source
        return Buffer.from(file.source, 'utf8').toString('base64')
      }
      if (file.bytes) return new TextDecoder().decode(file.bytes)
      if (file.encoding === 'base64') return Buffer.from(file.source, 'base64').toString('utf8')
      return file.source
    } finally {
      readCount--
    }
  }
)
const writeAsStringAsync = mock(
  async (uri: string, source: string, options?: { encoding?: string }) => {
    if (writeFailure?.(uri)) throw writeFailureError ?? new Error('Write failed')
    if (options?.encoding === 'base64') {
      files.set(uri, {
        source,
        encoding: 'base64',
        bytes: Uint8Array.from(Buffer.from(source, 'base64')),
      })
    } else {
      files.set(uri, { source })
    }
  }
)
const deleteAsync = mock(async (uri: string) => {
  files.delete(uri)
  if (!directories.has(uri)) return
  const prefix = `${uri}/`
  directories.delete(uri)
  for (const key of [...directories.keys()]) {
    if (key.startsWith(prefix)) directories.delete(key)
  }
  for (const key of [...files.keys()]) {
    if (key.startsWith(prefix)) files.delete(key)
  }
  for (const children of directories.values()) {
    const index = children.indexOf(uri)
    if (index !== -1) children.splice(index, 1)
  }
})
const readDirectoryAsync = mock(async (uri: string) => {
  if (unreadable.has(uri)) throw new Error('Directory access denied')
  const children = directories.get(uri)
  if (!children) throw new Error('No such directory')
  return [...children]
})
const readCachedDirectory = async (directory: string) => {
  const names = new Set<string>()
  for (const key of files.keys()) {
    if (!key.startsWith(directory)) continue
    const rest = key.slice(directory.length)
    if (rest && !rest.includes('/')) names.add(rest)
  }
  for (const key of directories.keys()) {
    if (key === directory || !key.startsWith(directory)) continue
    const rest = key.slice(directory.length).replace(/\/$/u, '')
    if (rest && !rest.includes('/')) names.add(rest)
  }
  return [...names]
}
const createFileAsync = mock(async (parent: string, name: string, _mime: string) => {
  if (createResult) return createResult
  if (parent === root) return addFile(name, '')
  const uri = childUri(parent, name)
  if (files.has(uri) || directories.has(uri)) throw new Error('Already exists')
  files.set(uri, { source: '' })
  directories.get(parent)?.push(uri)
  return uri
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
const downloadAsync = mock(async (_url: string, uri: string) => {
  files.set(uri, { source: '', bytes: downloadedBytes })
  return { status: downloadStatus, uri }
})
const moveAsync = mock(async ({ from, to }: { from: string; to: string }) => {
  const file = files.get(from)
  if (!file || files.has(to)) throw new Error('Cannot move file')
  files.set(to, file)
  files.delete(from)
})
const makeDirectoryAsync = mock(async (uri: string) => {
  if (!directories.has(uri)) directories.set(uri, [])
})

mock.module('expo-file-system', () => ({
  FileMode: { Truncate: 'wt' },
  File: class {
    constructor(private uri: string) {}
    async bytes() {
      const file = files.get(this.uri)
      if (!file) throw new Error('No such file')
      return fileBytes(file)
    }
    open(mode: string) {
      expect(mode).toBe('wt')
      files.set(this.uri, { source: '' })
      return {
        writeBytes: async (bytes: Uint8Array) => {
          if (handleWriteError) throw handleWriteError
          files.set(this.uri, { source: new TextDecoder().decode(bytes), bytes })
        },
        close: () => {
          handlesClosed++
        },
      }
    }
    get modificationTime() {
      const time = files.get(this.uri)?.modificationTime
      return time === undefined ? null : time * 1000
    }
    get size() {
      const file = files.get(this.uri)
      return file ? (file.size ?? fileBytes(file).length) : null
    }
    info() {
      detailedMetadataReads++
      const file = files.get(this.uri)
      return file
        ? {
            exists: true,
            modificationTime:
              file.modificationTime === undefined ? undefined : file.modificationTime * 1000,
            size: file.size ?? fileBytes(file).length,
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
  downloadAsync,
  moveAsync,
  makeDirectoryAsync,
  readDirectoryAsync: readCachedDirectory,
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: async () => {
      if (permissionError) throw permissionError
      return granted ? { granted: true, directoryUri: pickerUri } : { granted: false }
    },
    readDirectoryAsync,
    createFileAsync,
    makeDirectoryAsync: async (parent: string, name: string) => {
      if (!directories.has(parent)) throw new Error('No such directory')
      const uri = childUri(parent, name)
      if (files.has(uri) || directories.has(uri)) throw new Error('Already exists')
      directories.set(uri, [])
      directories.get(parent)?.push(uri)
      return uri
    },
  },
}))

const {
  pickVault,
  loadSavedVault,
  forgetVault,
  scanVault,
  createNote,
  saveNote,
  readNote,
  preparePdf,
  releasePdf,
  prepareSource,
  listTemplates,
  listNoteDirectories,
  loadCompileFiles,
  writeCompiledPdf,
  createPdfWriter,
} = await import('../src/vault')
const { packageArchive } = await import('../src/compiler/packages')
const { pdfStorage } = await import('../src/compiler/pdf-storage')
const { loadVaultIndex, storeVaultIndex } = await import('../src/library-cache')

beforeEach(() => {
  detailedMetadataReads = 0
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
  writeFailure = undefined
  writeFailureError = undefined
  downloadStatus = 200
  for (const fn of [
    getInfoAsync,
    readAsStringAsync,
    writeAsStringAsync,
    deleteAsync,
    readDirectoryAsync,
    createFileAsync,
    copyAsync,
    downloadAsync,
    moveAsync,
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

test('switching folders keeps the saved selection until a new folder is granted', async () => {
  await pickVault()
  pickerUri = addDirectory('other')
  writeAsStringAsync.mockClear()
  granted = false
  expect(await pickVault()).toBeNull()
  expect(await loadSavedVault()).toEqual(vault)
  expect(writeAsStringAsync).not.toHaveBeenCalled()
  expect(deleteAsync).not.toHaveBeenCalled()

  granted = true
  const next = { uri: pickerUri, name: 'other' }
  expect(await pickVault()).toEqual(next)
  expect(await loadSavedVault()).toEqual(next)
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
  for (const name of ['style', 'assets', 'fonts', '.direnv', '.git', '.hidden']) {
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
      modifiedAt: null,
    },
    { path: 'nested/deep.typ', uri: sub, title: 'Deep', pdfUri: deepPdf, modifiedAt: null },
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

test('opening a cached note reads current source without changing its file', async () => {
  const uri = addFile('cached.typ', '#title[Current source]')
  const current = await readNote(noteFor(uri, '#title[Old source]'))
  expect(current.source).toBe('#title[Current source]')
  expect(current.title).toBe('Current source')
  expect(writeAsStringAsync).not.toHaveBeenCalled()
})

test('scan still visits directories whose names end in .typ', async () => {
  const directory = addDirectory('folder.typ')
  addFile('folder.typ/note.typ', '= Nested', directory)
  expect((await scanVault(vault)).map((note) => note.path)).toEqual(['folder.typ/note.typ'])
})

test('scan avoids per-file metadata and legacy content streams', async () => {
  const directory = addDirectory('folder.with.dots')
  const uri = addFile('folder.with.dots/note.typ', 'Body without title', directory)
  files.set(uri, { source: 'Body without title' })
  const [note] = await scanVault(vault)
  expect(note.path).toBe('folder.with.dots/note.typ')
  expect(note.modifiedAt).toBeNull()
  expect(getInfoAsync.mock.calls.some(([uri]) => uri.startsWith('content://'))).toBe(false)
  expect(detailedMetadataReads).toBe(0)
})

test('scan publishes usable notes before the full vault finishes', async () => {
  for (let index = 0; index < 40; index++) addFile(`note_${index}.typ`)
  const batches: number[] = []
  const notes = await scanVault(vault, undefined, undefined, (partial) => {
    batches.push(partial.length)
    expect(partial.every((note) => note.source === '#title[Test]\n')).toBe(true)
    if (partial.length === 1) expect(readAsStringAsync.mock.calls.length).toBeLessThan(40)
  })
  expect(batches[0]).toBe(1)
  expect(batches.every((size, index) => index === 0 || size > batches[index - 1])).toBe(true)
  expect(notes).toHaveLength(40)
})

test('scan publishes all sources before visiting output folders', async () => {
  const output = addDirectory('out')
  addFile('out/main.pdf', 'PDF', output)
  const folder = addDirectory('notes')
  for (let index = 0; index < 20; index++) addFile(`notes/note_${index}.typ`, '= Note', folder)
  const batches: number[] = []
  await scanVault(vault, undefined, undefined, (partial) => {
    batches.push(partial.length)
    expect(readDirectoryAsync.mock.calls.some(([uri]) => uri === output)).toBe(false)
  })
  expect(batches[0]).toBe(1)
  expect(batches.at(-1)).toBe(20)
  expect(readDirectoryAsync.mock.calls.map(([uri]) => uri)).toEqual([root, folder, output])
})

test('scan cancellation during a batch drains reads without visiting more folders', async () => {
  const folder = addDirectory('nested')
  addFile('nested/later.typ', '= Later', folder)
  for (let index = 0; index < 40; index++) addFile(`note_${index}.typ`)
  let cancelled = false
  await expect(
    scanVault(
      vault,
      undefined,
      () => cancelled,
      () => {
        cancelled = true
      }
    )
  ).rejects.toThrow('cancelled')
  expect(readCount).toBe(0)
  expect(readAsStringAsync.mock.calls.length).toBeLessThan(40)
  expect(readDirectoryAsync.mock.calls.map(([uri]) => uri)).toEqual([root])
})

test('library snapshots reopen without reading source files and remain isolated by vault', async () => {
  const uri = addFile('note.typ')
  const note = noteFor(uri)
  await storeVaultIndex(vault, [note])
  const reads = readAsStringAsync.mock.calls.length
  expect(await loadVaultIndex(vault)).toEqual([note])
  expect(readAsStringAsync.mock.calls.length - reads).toBe(1)
  expect(readAsStringAsync.mock.calls.some(([path]) => path === uri)).toBe(false)
  expect(await loadVaultIndex({ ...vault, uri: `${root}-other` })).toBeNull()
})

test('corrupt and foreign library snapshots are ignored', async () => {
  await storeVaultIndex(vault, [noteFor('content://another-vault/note.typ')])
  expect(await loadVaultIndex(vault)).toBeNull()
  const uri = [...files.keys()].find((path) => path.includes('typo-library/')) ?? ''
  files.set(uri, { source: '{broken' })
  expect(await loadVaultIndex(vault)).toBeNull()
})

test('scan bounds source reads and reports every completed note', async () => {
  for (let index = 0; index < 40; index++) addFile(`note_${index}.typ`)
  const progress: number[] = []
  expect(await scanVault(vault, (count) => progress.push(count))).toHaveLength(40)
  expect(maximumReads).toBeGreaterThan(1)
  expect(maximumReads).toBeLessThanOrEqual(6)
  expect(progress).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
})

test('index cancellation stops before reading a folder or a note', async () => {
  addFile('note.typ')
  const before = readAsStringAsync.mock.calls.length
  await expect(scanVault(vault, undefined, () => true)).rejects.toThrow('cancelled')
  expect(readAsStringAsync.mock.calls).toHaveLength(before)
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

test('new notes use the chosen existing folder and return the full relative path', async () => {
  const notes = addDirectory('notes')
  const drafts = addDirectory('notes/drafts', notes)
  addFile('notes/other.typ', '#title[Other]\n', notes)
  const note = await createNote(vault, 'Nested Note', 'New body', 'notes/drafts')
  expect(createFileAsync).toHaveBeenCalledWith(
    drafts,
    'nested_note.typ',
    'application/octet-stream'
  )
  expect(note.uri).toBe(uriFor('notes/drafts/nested_note.typ'))
  expect(note.path).toBe('notes/drafts/nested_note.typ')
  expect(note.title).toBe('Nested Note')
  expect(files.get(note.uri)?.source).toBe(note.source)
  expect(files.get(uriFor('notes/other.typ'))?.source).toBe('#title[Other]\n')
})

test('new note collisions are checked in the chosen folder, not only the vault root', async () => {
  const notes = addDirectory('notes')
  const rootNote = await createNote(vault, 'Same Title', 'Root body')
  const nestedNote = await createNote(vault, 'Same Title', 'Nested body', 'notes')
  expect(rootNote.path).toBe('same_title.typ')
  expect(nestedNote.path).toBe('notes/same_title.typ')
  expect(nestedNote.uri).not.toBe(rootNote.uri)
  await expect(createNote(vault, 'Same Title', 'Duplicate', 'notes')).rejects.toThrow(
    'already exists'
  )
  expect(createFileAsync).toHaveBeenCalledTimes(2)
  expect(files.get(rootNote.uri)?.source).toBe(rootNote.source)
  expect(files.get(nestedNote.uri)?.source).toBe(nestedNote.source)
  expect(directories.get(notes)).toHaveLength(1)
})

test('creation rejects traversal, reserved, missing, and hidden folders plus unsafe names', async () => {
  const notes = addDirectory('notes')
  addDirectory('notes/drafts', notes)
  for (const directory of [
    '../outside',
    'notes/../../outside',
    '/outside',
    'notes/',
    'notes//drafts',
    'notes/./drafts',
    'notes\\drafts',
    '.hidden',
    'style',
    'assets',
    'fonts',
    'templates',
    'packages',
    'out',
    'missing',
    ' ',
  ]) {
    await expect(createNote(vault, 'Note', '', directory)).rejects.toThrow()
  }
  for (const title of ['../outside', '.hidden', 'a\\b', 'a/b', 'a\u0000b', 'a:b']) {
    await expect(createNote(vault, title, '')).rejects.toThrow()
  }
  expect(createFileAsync).not.toHaveBeenCalled()
  expect(writeAsStringAsync).not.toHaveBeenCalled()
})

test('note folder listing includes the root and safe existing nested folders only', async () => {
  const notes = addDirectory('notes')
  addDirectory('notes/drafts', notes)
  addDirectory('notes/archive', notes)
  const projects = addDirectory('projects')
  addDirectory('projects/deep', projects)
  for (const name of ['style', 'assets', 'fonts', 'templates', 'packages', 'out', '.git']) {
    addDirectory(name)
  }
  for (const name of ['assets', 'fonts', 'packages', '.hidden']) {
    addDirectory(`notes/${name}`, notes)
  }
  for (const name of ['style', 'assets', 'fonts', 'templates', 'packages', 'out']) {
    unreadable.add(uriFor(name))
  }
  expect(await listNoteDirectories(vault)).toEqual([
    '',
    'notes',
    'notes/archive',
    'notes/drafts',
    'projects',
    'projects/deep',
  ])
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

function nameOf(uri: string): string {
  const encoded = uri.slice(uri.lastIndexOf('/') + 1)
  const decoded = decodeURIComponent(encoded)
  return decoded.includes('/')
    ? decoded.slice(decoded.lastIndexOf('/') + 1)
    : decoded.replace(/^[^:]*:/u, '')
}

function shareNote(path: string): Note {
  return { uri: uriFor(path), path, title: 'Note', source: '', modifiedAt: null }
}

function pdfBase64(body = '%PDF-1.7\nbody'): string {
  return Buffer.from(body, 'utf8').toString('base64')
}

function storedBytes(uri: string): Buffer {
  const file = files.get(uri)
  if (!file) throw new Error(`Missing file ${uri}`)
  return Buffer.from(fileBytes(file))
}

function childNamed(parent: string, name: string): string | undefined {
  return directories.get(parent)?.find((uri) => nameOf(uri) === name)
}

test('package downloads are staged before caching and subsequent reads work offline', async () => {
  const spec = { namespace: 'preview', name: 'test', version: '1.0.0' }
  const result = await packageArchive(spec)
  const destination = 'file:///private/documents/typo-packages/test-1.0.0.tar.gz'
  expect(result).toBe(Buffer.from(downloadedBytes).toString('base64'))
  expect(files.has(destination)).toBe(true)
  expect(downloadAsync.mock.calls[0][1]).not.toBe(destination)
  expect(moveAsync).toHaveBeenCalledTimes(1)
  expect(await packageArchive(spec)).toBe(result)
  expect(downloadAsync).toHaveBeenCalledTimes(1)
  expect([...files.keys()].some((uri) => uri.endsWith('.tmp'))).toBe(false)
})

test('failed package downloads clean partial files and permit a retry', async () => {
  const spec = { namespace: 'preview', name: 'test', version: '1.0.0' }
  downloadStatus = 503
  await expect(packageArchive(spec)).rejects.toThrow('503')
  expect(files.size).toBe(0)
  downloadStatus = 200
  await expect(packageArchive(spec)).resolves.toBe(Buffer.from(downloadedBytes).toString('base64'))
  expect(downloadAsync).toHaveBeenCalledTimes(2)
})

test('invalid cached archives are removed and non-preview packages never use the network', async () => {
  const spec = { namespace: 'preview', name: 'test', version: '1.0.0' }
  const uri = 'file:///private/documents/typo-packages/test-1.0.0.tar.gz'
  files.set(uri, { source: 'invalid' })
  await expect(packageArchive(spec)).rejects.toThrow('invalid archive')
  expect(files.has(uri)).toBe(false)
  await expect(packageArchive({ ...spec, namespace: 'local' })).rejects.toThrow('Place @local')
  expect(downloadAsync).not.toHaveBeenCalled()
})

test('source sharing writes the complete unsaved buffer to a private cache copy', async () => {
  const uri = addFile('notes/My Note.typ', '#title[Old]\nSaved')
  const note: Note = {
    uri,
    path: 'notes/My Note.typ',
    title: 'Old',
    source: '#title[Old]\nSaved',
    modifiedAt: 123000,
  }
  const buffer = '#title[New]\nUnsaved {{body}} buffer'
  const shared = await prepareSource(note, buffer)
  expect(shared).toMatch(
    /^file:\/\/\/private\/cache\/typo-sources\/src-[a-z0-9]+-[a-z0-9]+\/My%20Note\.typ$/u
  )
  expect(files.get(shared)?.source).toBe(buffer)
  expect(files.get(uri)?.source).toBe('#title[Old]\nSaved')
  expect(writeAsStringAsync.mock.calls.every(([target]) => target !== uri)).toBe(true)
  const second = await prepareSource(note, 'next buffer')
  expect(second).not.toBe(shared)
  expect(files.has(shared)).toBe(true)
})

test('source sharing URI-escapes filenames without changing the basename or buffer', async () => {
  const name = 'Über #100%.typ'
  const shared = await prepareSource(shareNote(`notes/${name}`), 'Complete 📝 buffer\n')
  expect(decodeURIComponent(shared.slice(shared.lastIndexOf('/') + 1))).toBe(name)
  expect(shared).not.toContain('#')
  expect(files.get(shared)?.source).toBe('Complete 📝 buffer\n')
})

test('source cache keeps at most 24 sessions and removes copies older than one day', async () => {
  const base = 'file:///private/cache/typo-sources/'
  const old = `${base}src-${(Date.now() - 25 * 60 * 60 * 1000).toString(36)}-1`
  directories.set(old, [`${old}/old.typ`])
  files.set(`${old}/old.typ`, { source: 'old source' })
  for (let index = 0; index < 30; index++) {
    await prepareSource(shareNote('note.typ'), `source ${index}`)
  }
  expect(files.has(`${old}/old.typ`)).toBe(false)
  const sessions = (await readCachedDirectory(base)).filter((name) => name.startsWith('src-'))
  expect(sessions.length).toBeLessThanOrEqual(24)
  expect(sessions.length).toBeGreaterThan(20)
})

test('a failed source cache write removes its session and never touches the vault', async () => {
  const uri = addFile('note.typ', '#title[Note]\n')
  writeFailure = (target) => target.includes('/typo-sources/')
  writeFailureError = new Error('Cache full')
  await expect(prepareSource(shareNote('note.typ'), 'buffer')).rejects.toThrow('Cache full')
  expect(files.get(uri)?.source).toBe('#title[Note]\n')
  const sessions = (await readCachedDirectory('file:///private/cache/typo-sources/')).filter(
    (name) => name.startsWith('src-')
  )
  expect(sessions).toEqual([])
})

test('source sharing rejects unsafe or non-Typst basenames before writing', async () => {
  for (const path of ['folder/note.txt', 'folder/', 'a\\b.typ', 'a\u0000b.typ']) {
    await expect(prepareSource(shareNote(path), 'buffer')).rejects.toThrow()
  }
  expect([...files.keys()].filter((uri) => uri.startsWith('file:///private/cache/'))).toHaveLength(
    0
  )
})

test('templates prefer the vault root, then sorted custom files, then the builtin fallback', async () => {
  const rootTemplate = addFile('template.typ', '#import "style/lib.typ": *\n{{title}}\n{{body}}')
  const templates = addDirectory('templates')
  addFile('templates/essay.typ', 'Essay {{title}}\n\n{{body}}', templates)
  addFile('templates/plain_note.typ', 'Plain {{title}}', templates)
  addFile('templates/notes.txt', 'ignored', templates)
  addFile('templates/.hidden.typ', 'ignored', templates)
  const items = await listTemplates(vault)
  expect(items.map((item) => item.id)).toEqual([
    'template.typ',
    'templates/essay.typ',
    'templates/plain_note.typ',
    'builtin:plain',
  ])
  expect(items.map((item) => item.name)).toEqual([
    'Vault template',
    'Essay',
    'Plain note',
    'Plain note',
  ])
  expect(items[0].source).toBe(files.get(rootTemplate)?.source ?? '')
  expect(items[3].source).toContain('{{title}}')
  expect(items[3].source).toContain('{{body}}')
})

test('templates fall back to the standalone builtin and report unreadable files', async () => {
  expect((await listTemplates(vault)).map((item) => item.id)).toEqual(['builtin:plain'])
  const template = addFile('template.typ', '{{title}}')
  unreadable.add(template)
  await expect(listTemplates(vault)).rejects.toThrow('Cannot read the note template')
})

test('the note index excludes templates while compiler inputs include root Typst resources', async () => {
  addFile('template.typ', '{{title}}\n{{body}}')
  const templates = addDirectory('templates')
  addFile('templates/essay.typ', 'Essay {{title}}', templates)
  addFile('note.typ', '#title[Note]\n')
  expect((await scanVault(vault)).map((note) => note.path)).toEqual(['note.typ'])
  const inputs = await loadCompileFiles(vault)
  expect(inputs.map((file) => file.path)).toEqual(['note.typ', 'template.typ'])
})

test('new notes can use a portable template source without losing the default scaffold', async () => {
  const portable = await createNote(vault, 'Portable', 'Body', '', '{{title}}\n\n{{body}}\n')
  expect(portable.source).toBe('Portable\n\nBody\n')
  expect(files.get(portable.uri)?.source).toBe(portable.source)
  const classic = await createNote(vault, 'Classic', 'Body')
  expect(classic.source).toContain('#import "style/lib.typ": *')
  expect(classic.source).toContain('#title[Classic]')
  await expect(createNote(vault, 'Broken', 'Body', '', 'No title field')).rejects.toThrow(
    'must include {{title}}'
  )
  expect(createFileAsync).toHaveBeenCalledTimes(2)
})

test('compiler inputs include supported vault files and skip output and unsupported media', async () => {
  const style = addDirectory('style')
  const styleTyp = addFile('style/lib.typ', '#let template = it => it', style)
  addFile('style/theme.yml', 'theme: parchment', style)
  const assets = addDirectory('assets')
  const logo = addFile('assets/logo.svg', '<svg></svg>', assets)
  addFile('assets/video.mp4', 'video', assets)
  addFile('assets/sound.mp3', 'audio', assets)
  addFile('assets/archive.zip', 'zip', assets)
  addFile('assets/old.pdf', '%PDF-1.7', assets)
  addFile('assets/app.apk', 'apk', assets)
  const fonts = addDirectory('fonts')
  addFile('fonts/body.ttf', 'font bytes', fonts)
  const out = addDirectory('out')
  addFile('out/note.pdf', '%PDF-1.7', out)
  addDirectory('.git')
  const templates = addDirectory('templates')
  addFile('templates/essay.typ', '{{title}}', templates)
  const bibliography = addFile('refs.bib', '@book{one}')
  addFile('data.csv', 'a,b')
  addFile('plugin.wasm', 'wasm')
  addFile('unsupported.bin', 'binary')
  const notes = addDirectory('notes')
  const nested = addFile('notes/deep.typ', '#title[Deep]', notes)
  const image = addFile('notes/image.png', 'png bytes', notes)
  const inputs = await loadCompileFiles(vault)
  expect(detailedMetadataReads).toBe(0)
  expect(inputs.map((file) => file.path)).toEqual([
    'assets/logo.svg',
    'data.csv',
    'fonts/body.ttf',
    'notes/deep.typ',
    'notes/image.png',
    'plugin.wasm',
    'refs.bib',
    'style/lib.typ',
    'style/theme.yml',
  ])
  const byPath = new Map(inputs.map((file) => [file.path, file.base64]))
  for (const [path, uri] of [
    ['style/lib.typ', styleTyp],
    ['assets/logo.svg', logo],
    ['refs.bib', bibliography],
    ['notes/deep.typ', nested],
    ['notes/image.png', image],
  ]) {
    expect(byPath.get(path)).toBe(storedBytes(uri).toString('base64'))
  }
})

test('portable package files stay out of the note index and retain internal resource directories', async () => {
  addFile('note.typ')
  let parent = root
  let path = ''
  for (const name of ['packages', 'local', 'test', '1.0.0']) {
    path = path ? `${path}/${name}` : name
    parent = addDirectory(path, parent)
  }
  addFile(`${path}/lib.typ`, '#let value = 1', parent)
  const templates = addDirectory(`${path}/templates`, parent)
  addFile(`${path}/templates/part.typ`, '#let part = 2', templates)
  const output = addDirectory(`${path}/out`, parent)
  addFile(`${path}/out/plugin.wasm`, 'plugin bytes', output)
  expect((await scanVault(vault)).map((note) => note.path)).toEqual(['note.typ'])
  const inputs = (await loadCompileFiles(vault)).map((file) => file.path)
  expect(inputs).toContain(`${path}/templates/part.typ`)
  expect(inputs).toContain(`${path}/out/plugin.wasm`)
})

test('compiler input bounds reject oversized files and totals before reading them', async () => {
  const big = addFile('big.png', 'small source')
  const bigFile = files.get(big)
  if (bigFile) bigFile.size = 32 * 1024 * 1024 + 1
  await expect(loadCompileFiles(vault)).rejects.toThrow('per-file limit')
  expect(readAsStringAsync).not.toHaveBeenCalled()

  files.clear()
  directories.set(root, [])
  for (const name of ['one.png', 'two.png', 'three.png', 'four.png']) {
    const uri = addFile(name, 'small source')
    const file = files.get(uri)
    if (file) file.size = 30 * 1024 * 1024
  }
  await expect(loadCompileFiles(vault)).rejects.toThrow('total limit')
  expect(readAsStringAsync).not.toHaveBeenCalled()
})

test('unreadable compiler inputs fail with the input path', async () => {
  const style = addDirectory('style')
  const uri = addFile('style/lib.typ', '#let template = it => it', style)
  unreadable.add(uri)
  await expect(loadCompileFiles(vault)).rejects.toThrow(
    'Cannot read compiler input "style/lib.typ"'
  )
})

test('compiler collection fails safely on repeated directory URIs', async () => {
  const notes = addDirectory('notes')
  addFile('notes/note.typ', '#title[Note]\n', notes)
  directories.get(notes)?.push(notes)
  await expect(loadCompileFiles(vault)).rejects.toThrow('repeated directory')
  expect(readAsStringAsync).not.toHaveBeenCalled()
})

test('compiled PDFs replace output files with exact bytes and no stale trailing data', async () => {
  const source = '#title[Note]\nBody'
  const uri = addFile('note.typ', source)
  const note: Note = { uri, path: 'note.typ', title: 'Note', source, modifiedAt: null }
  const longPdf = `%PDF-1.7\n${'x'.repeat(200)}`
  const first = await writeCompiledPdf(vault, note, pdfBase64(longPdf))
  expect(first).toBe(uriFor('out/note.pdf'))
  expect(nameOf(first)).toBe('note.pdf')
  expect(storedBytes(first).toString('utf8')).toBe(longPdf)
  expect(childNamed(root, 'out')).toBeDefined()
  const shortPdf = '%PDF-1.7\nshort'
  const second = await writeCompiledPdf(vault, note, pdfBase64(shortPdf))
  expect(second).toBe(first)
  expect(storedBytes(first).toString('utf8')).toBe(shortPdf)
  expect(handlesClosed).toBe(2)
})

test('a shared PDF writer avoids rescanning output folders for each note', async () => {
  const one = addFile('one.typ', 'One')
  const two = addFile('two.typ', 'Two')
  const write = createPdfWriter(vault)
  await write({ ...noteFor(one, 'One'), path: 'one.typ' }, pdfBase64())
  const firstReads = readDirectoryAsync.mock.calls.length
  await write({ ...noteFor(two, 'Two'), path: 'two.typ' }, pdfBase64())
  expect(readDirectoryAsync.mock.calls.length).toBe(firstReads)
  expect(files.get(uriFor('out/two.pdf'))?.bytes).toBeDefined()
})

test('PDF output lookup reads metadata only for the target path', async () => {
  const source = '#title[Note]\nBody'
  const uri = addFile('note.typ', source)
  const note: Note = { uri, path: 'note.typ', title: 'Note', source, modifiedAt: null }
  const out = addDirectory('out')
  addFile('out/note.pdf', '%PDF-1.7\nold', out)
  for (let index = 0; index < 60; index++) {
    addFile(`other_${index}.typ`)
    addFile(`out/other_${index}.pdf`, '%PDF-1.7', out)
  }
  const destination = await writeCompiledPdf(vault, note, pdfBase64())
  expect(destination).toBe(uriFor('out/note.pdf'))
  expect(detailedMetadataReads).toBeLessThan(6)
})

test('nested notes create matching out directories', async () => {
  const notes = addDirectory('notes')
  const uri = addFile('notes/deep.typ', '#title[Deep]\n', notes)
  const note: Note = {
    uri,
    path: 'notes/deep.typ',
    title: 'Deep',
    source: '#title[Deep]\n',
    modifiedAt: null,
  }
  const destination = await writeCompiledPdf(vault, note, pdfBase64())
  const out = childNamed(root, 'out')
  expect(out).toBeDefined()
  const nested = out ? childNamed(out, 'notes') : undefined
  expect(nested).toBeDefined()
  expect(nested ? childNamed(nested, 'deep.pdf') : undefined).toBe(destination)
  expect(destination).toBe(uriFor('out/notes/deep.pdf'))
  expect(nameOf(destination)).toBe('deep.pdf')
})

test('PDF creation rejects a provider URI outside the requested parent', async () => {
  const source = '#title[Note]\n'
  const uri = addFile('note.typ', source)
  const note: Note = { uri, path: 'note.typ', title: 'Note', source, modifiedAt: null }
  createResult = uriFor('elsewhere/note.pdf')
  await expect(writeCompiledPdf(vault, note, pdfBase64())).rejects.toThrow('requested PDF filename')
  expect(handlesClosed).toBe(0)
  expect(files.get(uri)?.source).toBe(source)
})

test('bad PDF bytes are rejected before the out folder or PDF is created', async () => {
  const source = '#title[Note]\n'
  const uri = addFile('note.typ', source)
  const note: Note = { uri, path: 'note.typ', title: 'Note', source, modifiedAt: null }
  await expect(
    writeCompiledPdf(vault, note, Buffer.from('not a pdf').toString('base64'))
  ).rejects.toThrow('%PDF-')
  expect(childNamed(root, 'out')).toBeUndefined()
  expect([...files.keys()].some((path) => path.endsWith('note.pdf'))).toBe(false)
})

test('external source changes stop the PDF write and preserve the old PDF', async () => {
  const source = '#title[Old]\n'
  const uri = addFile('note.typ', source)
  const out = addDirectory('out')
  const oldPdf = addFile('out/note.pdf', '%PDF-1.7\nold longer content', out)
  files.set(uri, { source: 'Syncthing changed this file' })
  const note: Note = { uri, path: 'note.typ', title: 'Old', source, modifiedAt: null }
  await expect(writeCompiledPdf(vault, note, pdfBase64())).rejects.toThrow(
    'changed outside this editor'
  )
  expect(files.get(oldPdf)?.source).toBe('%PDF-1.7\nold longer content')
})

test('compiled output paths cannot escape the vault', async () => {
  for (const path of [
    '../escape.typ',
    '/absolute.typ',
    'notes/../note.typ',
    'out/note.typ',
    'templates/note.typ',
    'note.txt',
    '.hidden.typ',
  ]) {
    const note: Note = {
      uri: uriFor(path),
      path,
      title: 'Note',
      source: '#title[Note]\n',
      modifiedAt: null,
    }
    await expect(writeCompiledPdf(vault, note, pdfBase64())).rejects.toThrow()
  }
  expect(childNamed(root, 'out')).toBeUndefined()
  expect(files.size).toBe(0)
})

test('PDF manifests and private bytes survive storage recreation and remain vault-specific', async () => {
  const cache = pdfStorage(root)
  const uri = await cache.cache('content-key', pdfBase64())
  const record = {
    sourceHash: 'source',
    fontsHash: 'fonts',
    dependencies: { 'style/lib.typ': 'style', 'missing.typ': null },
    uri,
  }
  await cache.save('nested/note.typ', record)
  const reopened = pdfStorage(root)
  expect(await reopened.read('nested/note.typ')).toEqual(record)
  expect(await reopened.base64(uri)).toBe(pdfBase64())
  expect(await reopened.stamp(uri)).not.toBeNull()
  expect(await pdfStorage(`${root}-other`).read('nested/note.typ')).toBeNull()
  expect(await reopened.read('different.typ')).toBeNull()
})

test('missing or corrupt PDF cache records are cache misses and invalid PDFs are rejected', async () => {
  const cache = pdfStorage(root)
  expect(await cache.read('note.typ')).toBeNull()
  await expect(cache.cache('bad', 'not a PDF')).rejects.toThrow('not return a PDF')
  const uri = await cache.cache('good', pdfBase64())
  await cache.save('note.typ', { sourceHash: 'source', fontsHash: 'fonts', dependencies: {}, uri })
  files.delete(uri)
  expect(await cache.read('note.typ')).toBeNull()
  expect(await cache.stamp(uri)).toBeNull()
  const manifest = [...files.keys()].find((path) => path.endsWith('.json')) ?? ''
  files.set(manifest, { source: '{broken' })
  expect(await cache.read('note.typ')).toBeNull()
})

test('PDF cache prunes orphan drafts before writes without delaying cache reads', async () => {
  const cache = pdfStorage(root)
  const retained = await cache.cache('saved', pdfBase64())
  await cache.save('note.typ', {
    sourceHash: 'source',
    fontsHash: 'fonts',
    dependencies: {},
    uri: retained,
  })
  const draft = await cache.cache('draft', pdfBase64())
  const source = addFile('note.typ')
  const output = addFile('note.pdf', '%PDF-1.7')
  const reopened = pdfStorage(root)
  await reopened.read('note.typ')
  expect(files.has(draft)).toBe(true)
  await reopened.cache('next-draft', pdfBase64())
  expect(files.has(retained)).toBe(true)
  expect(files.has(draft)).toBe(false)
  expect(files.has(source)).toBe(true)
  expect(files.has(output)).toBe(true)
})
