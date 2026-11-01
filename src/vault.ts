import { Directory, File, FileMode } from 'expo-file-system'
import * as FileSystem from 'expo-file-system/legacy'
import { buildNoteSource, extractTitle, noteFilename } from './core'
import type { Note, Vault } from './types'

const SAF = FileSystem.StorageAccessFramework
const IO_CONCURRENCY = 6
const excludedDirectories = new Set(['style', 'assets', 'out', '.direnv', '.git'])
let pdfSequence = 0

type Entry = { uri: string; path: string; modifiedAt: number | null }
type EntryInfo = { exists: boolean; isDirectory: boolean; modificationTime?: number }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function selectionPath(): string {
  if (!FileSystem.documentDirectory) throw new Error('Private document storage is unavailable.')
  return `${FileSystem.documentDirectory}typo-vault.json`
}

function documentName(uri: string): string {
  const encoded = uri.slice(uri.lastIndexOf('/') + 1)
  const decoded = decodeURIComponent(encoded)
  const name = decoded.includes('/')
    ? decoded.slice(decoded.lastIndexOf('/') + 1)
    : decoded.replace(/^[^:]*:/u, '')
  if (!name || name === '.' || name === '..' || /[/\\\p{Cc}]/u.test(name)) {
    throw new Error('The document provider returned an unsupported document name.')
  }
  return name
}

function validateVault(value: unknown): Vault {
  if (
    !value ||
    typeof value !== 'object' ||
    !('uri' in value) ||
    typeof value.uri !== 'string' ||
    !value.uri.startsWith('content://') ||
    !value.uri.includes('/tree/') ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !value.name.trim()
  ) {
    throw new Error('The saved vault selection is invalid. Forget it and choose the folder again.')
  }
  if (!value.uri.startsWith('content://com.android.externalstorage.documents/tree/')) {
    throw new Error(
      'Choose a local folder under Internal storage or your SD card. This build does not support cloud or other document providers.'
    )
  }
  return { uri: value.uri, name: value.name }
}

function modifiedAt(info: EntryInfo): number | null {
  return typeof info.modificationTime === 'number' && Number.isFinite(info.modificationTime)
    ? info.modificationTime
    : null
}

async function entryInfo(uri: string): Promise<EntryInfo> {
  if (new Directory(uri).exists) return { exists: true, isDirectory: true }
  const info = new File(uri).info()
  return { ...info, isDirectory: false }
}

async function boundedMap<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  let failure: unknown
  await Promise.all(
    Array.from({ length: Math.min(IO_CONCURRENCY, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++
        try {
          results[index] = await work(items[index])
        } catch (error) {
          failed = true
          failure ??= error
        }
      }
    })
  )
  if (failed) throw failure
  return results
}

export async function pickVault(): Promise<Vault | null> {
  // Expo takes persistable URI permissions before resolving a granted selection.
  const permission = await SAF.requestDirectoryPermissionsAsync()
  if (!permission.granted) return null
  const vault = validateVault({
    uri: permission.directoryUri,
    name: documentName(permission.directoryUri),
  })
  await FileSystem.writeAsStringAsync(selectionPath(), JSON.stringify(vault))
  return vault
}

export async function loadSavedVault(): Promise<Vault | null> {
  const path = selectionPath()
  if (!(await FileSystem.getInfoAsync(path)).exists) return null
  let vault: Vault
  try {
    vault = validateVault(JSON.parse(await FileSystem.readAsStringAsync(path)))
  } catch (error) {
    throw new Error(`Cannot load the saved vault: ${message(error)}`)
  }
  try {
    await SAF.readDirectoryAsync(vault.uri)
  } catch (error) {
    throw new Error(`Cannot access the saved vault. Choose the folder again: ${message(error)}`)
  }
  return vault
}

export async function forgetVault(): Promise<void> {
  await FileSystem.deleteAsync(selectionPath(), { idempotent: true })
}

export async function scanVault(
  vault: Vault,
  onProgress?: (count: number) => void
): Promise<Note[]> {
  const sources: Entry[] = []
  const pdfs = new Map<string, string>()
  const pending = [{ uri: vault.uri, path: '', output: false }]
  const seen = new Set<string>()
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index]
    if (seen.has(directory.uri)) {
      throw new Error(`Cannot index the vault: repeated directory at "${directory.path}".`)
    }
    seen.add(directory.uri)
    try {
      const uris = await SAF.readDirectoryAsync(directory.uri)
      const entries = await boundedMap(uris, async (uri) => {
        const name = documentName(uri)
        if (name.startsWith('.')) return null
        if (!directory.output && name !== 'out' && excludedDirectories.has(name)) return null
        const info = await entryInfo(uri)
        const path = directory.path ? `${directory.path}/${name}` : name
        if (!info.exists)
          throw new Error(`Cannot read "${path}". It disappeared or access was denied.`)
        return { uri, name, path, info }
      })
      for (const entry of entries) {
        if (!entry) continue
        const { uri, name, path, info } = entry
        if (info.isDirectory) {
          if (directory.output) pending.push({ uri, path, output: true })
          else if (directory.path === '' && name === 'out') {
            pending.push({ uri, path: '', output: true })
          } else if (!excludedDirectories.has(name)) pending.push({ uri, path, output: false })
        } else if (directory.output && /\.pdf$/iu.test(name)) {
          pdfs.set(path.replace(/\.pdf$/iu, '.pdf'), uri)
        } else if (!directory.output && /\.typ$/iu.test(name)) {
          sources.push({ uri, path, modifiedAt: modifiedAt(info) })
        }
      }
    } catch (error) {
      throw new Error(
        `Cannot index "${directory.path || (directory.output ? 'out' : vault.name)}": ${message(error)}`
      )
    }
  }
  let count = 0
  const notes = await boundedMap(sources, async (entry): Promise<Note> => {
    try {
      const source = await FileSystem.readAsStringAsync(entry.uri)
      const pdfUri = pdfs.get(entry.path.replace(/\.typ$/iu, '.pdf'))
      const note: Note = {
        ...entry,
        title: extractTitle(source, entry.path.slice(entry.path.lastIndexOf('/') + 1)),
        source,
        ...(pdfUri ? { pdfUri } : {}),
      }
      onProgress?.(++count)
      return note
    } catch (error) {
      throw new Error(
        `Cannot read note "${entry.path}". The vault index is incomplete: ${message(error)}`
      )
    }
  })
  return notes.sort((a, b) => a.path.localeCompare(b.path))
}

async function writeSource(uri: string, source: string): Promise<void> {
  if (!FileSystem.cacheDirectory) throw new Error('Private cache storage is unavailable.')
  const staging = `${FileSystem.cacheDirectory}typo-save-${Date.now()}-${++pdfSequence}.tmp`
  try {
    await FileSystem.writeAsStringAsync(staging, source)
    const bytes = await new File(staging).bytes()
    // SAF's ordinary write mode can leave old trailing bytes when a note gets shorter.
    const handle = new File(uri).open(FileMode.Truncate)
    try {
      await handle.writeBytes(bytes)
    } finally {
      handle.close()
    }
  } finally {
    await FileSystem.deleteAsync(staging, { idempotent: true }).catch(() => {})
  }
}

export async function createNote(
  vault: Vault,
  title: string,
  body: string,
  directory = ''
): Promise<Note> {
  if (directory !== '') {
    throw new Error(
      'New notes can only be created in the vault root. Nested directories are not supported.'
    )
  }
  const filename = noteFilename(title)
  if (
    filename.startsWith('.') ||
    filename !== filename.trim() ||
    /[/\\:*?"<>|\p{Cc}]/u.test(filename) ||
    !/\.typ$/u.test(filename)
  ) {
    throw new Error(
      'The note filename is unsafe. Choose a title without paths or filename punctuation.'
    )
  }
  const source = buildNoteSource(title, body)
  const existing = await SAF.readDirectoryAsync(vault.uri)
  if (existing.some((uri) => documentName(uri).toLowerCase() === filename.toLowerCase())) {
    throw new Error(`A file named "${filename}" already exists. Choose a different title.`)
  }
  // A text/plain MIME type can cause Android providers to append an unwanted .txt extension.
  const uri = await SAF.createFileAsync(vault.uri, filename, 'application/octet-stream')
  if (existing.includes(uri) || documentName(uri) !== filename) {
    throw new Error(
      'The document provider did not create the requested new filename. Nothing was written; refresh the vault.'
    )
  }
  await writeSource(uri, source)
  return {
    uri,
    path: filename,
    title: extractTitle(source, filename),
    source,
    modifiedAt: modifiedAt(await entryInfo(uri)),
  }
}

export async function saveNote(note: Note, source: string): Promise<Note> {
  const current = await FileSystem.readAsStringAsync(note.uri)
  if (current !== note.source) {
    throw new Error(
      `Cannot save "${note.path}": the file changed outside this editor, possibly through Syncthing. Return to the notes list, refresh, and reopen it before saving to avoid overwriting those changes.`
    )
  }
  await writeSource(note.uri, source)
  return {
    uri: note.uri,
    path: note.path,
    title: extractTitle(source, note.path.slice(note.path.lastIndexOf('/') + 1)),
    source,
    modifiedAt: modifiedAt(await entryInfo(note.uri)),
  }
}

export async function preparePdf(note: Note): Promise<string> {
  if (!note.pdfUri) {
    throw new Error(
      'No current PDF is available for this note. Wait for compilation and refresh the vault.'
    )
  }
  if (!FileSystem.cacheDirectory) throw new Error('Private cache storage is unavailable.')
  const directory = `${FileSystem.cacheDirectory}typo-pdfs/`
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
  const cached = (await FileSystem.readDirectoryAsync(directory))
    .filter((name) => /^note-[a-z0-9]+-[a-z0-9]+\.pdf$/u.test(name))
    .sort((a, b) => Number.parseInt(b.split('-')[1], 36) - Number.parseInt(a.split('-')[1], 36))
  await Promise.all(
    cached
      .filter(
        (name, index) =>
          index >= 23 || Date.now() - Number.parseInt(name.split('-')[1], 36) > 86_400_000
      )
      .map((name) => FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true }))
  )
  let destination: string
  do {
    destination = `${directory}note-${Date.now().toString(36)}-${(++pdfSequence).toString(36)}.pdf`
  } while ((await FileSystem.getInfoAsync(destination)).exists)
  try {
    await FileSystem.copyAsync({ from: note.pdfUri, to: destination })
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {})
    throw new Error(
      `Cannot prepare this PDF. It may have changed during synchronization: ${message(error)}`
    )
  }
  return destination
}

export async function releasePdf(uri: string): Promise<void> {
  const prefix = `${FileSystem.cacheDirectory}typo-pdfs/`
  if (uri.startsWith(prefix) && /^note-[a-z0-9]+-[a-z0-9]+\.pdf$/u.test(uri.slice(prefix.length))) {
    await FileSystem.deleteAsync(uri, { idempotent: true })
  }
}
