import { Directory, File, FileMode } from 'expo-file-system'
import * as FileSystem from 'expo-file-system/legacy'
import {
  buildNoteSource,
  DEFAULT_TEMPLATE,
  extractTitle,
  isRootTemplate,
  noteFilename,
  validateNoteTemplate,
} from './core'
import { sha256 } from './hash'
import type { Note, Vault } from './types'
import { listVaultEntries, readVaultBase64, readVaultText } from './vault-native'

export type NoteFolder = {
  path: string
  name: string
}

export type TrashedNote = { uri: string; path: string }

export type CompileFile = {
  path: string
  base64: string
}

// Provider listing stamps for files that were already read, so a periodic
// refresh does not read the whole vault again.
export type CompileFileCache = {
  entries: Map<
    string,
    { uri: string; stamp: string; size: number; readAt: number; file: CompileFile }
  >
  files?: CompileFile[]
}

const SAF = FileSystem.StorageAccessFramework
const IO_CONCURRENCY = 24
// A file can grow after preflight, so allow for full-size results in flight.
const COMPILE_READ_CONCURRENCY = 2
const MAX_COMPILE_FILE = 32 * 1024 * 1024
const MAX_COMPILE_TOTAL = 100 * 1024 * 1024
// A provider can rewrite a file without changing its size or modification time,
// so a stamp only stands in for a read for a minute before the file is read again.
const COMPILE_STAMP_MAX_AGE = 60_000
const SOURCE_CACHE_MAX_AGE = 86_400_000
const SOURCE_CACHE_SESSIONS = 24
const excludedDirectories = new Set(['style', 'assets', 'packages', 'out', '.direnv', '.git'])
const compileExcludedDirectories = new Set(['out', '.direnv', '.git'])
const noteExcludedDirectories = new Set([...excludedDirectories, 'fonts'])
const compileExtensions = new Set([
  '.typ',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.ttf',
  '.otf',
  '.ttc',
  '.yml',
  '.yaml',
  '.bib',
  '.json',
  '.csv',
  '.xml',
  '.toml',
  '.txt',
  '.wasm',
])
const reservedNoteDirectories = new Set(['out', 'packages', '.direnv', '.git'])
let pdfSequence = 0

type EntryInfo = { exists: boolean; isDirectory: boolean; modificationTime?: number; size?: number }
type ListedEntry = { uri: string; name: string; info: EntryInfo }
type OutputListings = Map<string, { readAt: number; entries: { uri: string; name: string }[] }>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function selectionPath(): string {
  if (!FileSystem.documentDirectory) throw new Error('Private document storage is unavailable.')
  // The quick note tile reads this file to enable or disable itself.
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

function modifiedAt(info: { modificationTime?: number }): number | null {
  return typeof info.modificationTime === 'number' && Number.isFinite(info.modificationTime)
    ? info.modificationTime
    : null
}

function listingStamp(info: EntryInfo): string | undefined {
  const modified = modifiedAt(info)
  return modified !== null && typeof info.size === 'number' ? `${modified}:${info.size}` : undefined
}

async function entryInfo(uri: string): Promise<EntryInfo> {
  if (new Directory(uri).exists) return { exists: true, isDirectory: true }
  const info = new File(uri).info()
  return { ...info, isDirectory: false }
}

async function boundedMap<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
  concurrency = IO_CONCURRENCY
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  let failure: unknown
  let lastYield = performance.now()
  let yielding: Promise<void> | undefined
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && next < items.length) {
        try {
          // Recheck after a shared yield to avoid a burst of synchronous native getters.
          while (yielding || performance.now() - lastYield >= 8) {
            yielding ??= new Promise<void>((resolve) =>
              setTimeout(() => {
                lastYield = performance.now()
                yielding = undefined
                resolve()
              }, 0)
            )
            await yielding
          }
          if (failed || next === items.length) return
          const index = next++
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

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

function decodedSize(base64: string): number {
  const compact = /\s/u.test(base64) ? base64.replace(/\s+/gu, '') : base64
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding)
}

function assertPdfBase64(pdfBase64: string): void {
  // "%PDF-" encodes to the start of this base64 prefix.
  const compact =
    typeof pdfBase64 === 'string' && /\s/u.test(pdfBase64)
      ? pdfBase64.replace(/\s+/gu, '')
      : pdfBase64
  if (typeof compact !== 'string' || !compact.startsWith('JVBERi0')) {
    throw new Error(
      'The compiler returned data that is not a PDF (missing the %PDF- signature). The existing PDF was left unchanged.'
    )
  }
}

function sourceFilename(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[/\\\p{Cc}]/u.test(name) ||
    !/\.typ$/iu.test(name)
  ) {
    throw new Error(
      'Cannot prepare this source file. The note filename is unsafe or is not a .typ file.'
    )
  }
  return name
}

function pdfOutput(path: string): { directories: string[]; filename: string; path: string } {
  if (
    !path ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    /[\p{Cc}]/u.test(path)
  ) {
    throw new Error(
      `Cannot write the PDF for "${path}": the note path is not a safe relative path.`
    )
  }
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(
      `Cannot write the PDF for "${path}": the note path is not a safe relative path.`
    )
  }
  const source = segments[segments.length - 1]
  const stem = source.replace(/\.typ$/iu, '')
  if (!/\.typ$/iu.test(source) || !stem || stem === '.' || stem === '..' || stem.startsWith('.')) {
    throw new Error(
      `Cannot write the PDF for "${path}": only safe, non-hidden .typ notes can be compiled.`
    )
  }
  const directories = segments.slice(0, -1)
  if (directories.some((directory) => reservedNoteDirectories.has(directory.toLowerCase()))) {
    throw new Error(
      `Cannot write the PDF for "${path}": notes in reserved folders are not compiled.`
    )
  }
  const filename = `${stem}.pdf`
  return { directories, filename, path: ['out', ...directories, filename].join('/') }
}

async function listedEntries(
  uri: string,
  context: string,
  skipHidden = false,
  metadata: 'full' | 'compile' | 'directories' = 'full',
  include: (name: string) => boolean = () => true
): Promise<ListedEntry[]> {
  let uris: string[]
  let bulk: Awaited<ReturnType<typeof listVaultEntries>> = null
  try {
    if (metadata === 'compile') bulk = await listVaultEntries(uri)
    uris = bulk ? bulk.map((entry) => entry.uri) : await SAF.readDirectoryAsync(uri)
  } catch (error) {
    throw new Error(`Cannot read the folder "${context}": ${message(error)}`)
  }
  const byUri = new Map(bulk?.map((entry) => [entry.uri, entry]))
  const included = uris
    .map((child) => ({ child, name: documentName(child) }))
    .filter(({ name }) => !(skipHidden && name.startsWith('.')) && include(name))
  const entries = await boundedMap(included, async ({ child, name }) => {
    let info: EntryInfo
    const entry = byUri.get(child)
    if (entry) {
      const size = entry.isDirectory ? undefined : (entry.size ?? new File(child).size)
      info = {
        exists: size !== null,
        isDirectory: entry.isDirectory,
        modificationTime: entry.modificationTime,
        size: size ?? undefined,
      }
    } else if (metadata !== 'full') {
      if (new Directory(child).exists) info = { exists: true, isDirectory: true }
      else {
        if (metadata === 'directories') return null
        const size = new File(child).size
        info = { exists: size !== null, isDirectory: false, size: size ?? undefined }
      }
    } else info = await entryInfo(child)
    if (!info.exists) {
      throw new Error(`Cannot read "${name}" in "${context}". It disappeared or access was denied.`)
    }
    return { uri: child, name, info }
  })
  return entries.filter((entry): entry is ListedEntry => entry !== null)
}

function isChildUri(parent: string, child: string, name: string): boolean {
  // SAF encodes the full child path in a document ID instead of extending the parent URI.
  const tree = parent.split('/document/')[0]
  const parentId = decodeURIComponent(parent.slice(parent.lastIndexOf('/') + 1))
  const childId = decodeURIComponent(child.slice(child.lastIndexOf('/') + 1))
  return child.startsWith(`${tree}/document/`) && childId === `${parentId}/${name}`
}

async function outputEntries(
  parent: string,
  name: string,
  context: string,
  cache?: OutputListings
): Promise<ListedEntry[]> {
  if (!cache)
    return listedEntries(
      parent,
      context,
      true,
      'full',
      (entry) => entry.toLowerCase() === name.toLowerCase()
    )
  let listing = cache.get(parent)
  if (!listing || Date.now() - listing.readAt > 15000) {
    const uris = await SAF.readDirectoryAsync(parent)
    listing = { readAt: Date.now(), entries: uris.map((uri) => ({ uri, name: documentName(uri) })) }
    if (cache.size >= 64) cache.clear()
    cache.set(parent, listing)
  }
  return Promise.all(
    listing.entries
      .filter((entry) => entry.name.toLowerCase() === name.toLowerCase())
      .map(async (entry) => ({ ...entry, info: await entryInfo(entry.uri) }))
  )
}

function rememberOutput(cache: OutputListings | undefined, parent: string, uri: string) {
  cache?.get(parent)?.entries.push({ uri, name: documentName(uri) })
}

async function ensureVaultDirectory(
  parent: string,
  name: string,
  context: string,
  cache?: OutputListings
): Promise<string> {
  const entries = await outputEntries(parent, name, context, cache)
  const matches = entries
  if (matches.length > 1) {
    throw new Error(`Cannot write "${context}": more than one "${name}" entry exists.`)
  }
  const existing = matches[0]
  if (existing) {
    if (!existing.info.isDirectory) {
      throw new Error(`Cannot write "${context}": "${existing.name}" is a file, not a directory.`)
    }
    return existing.uri
  }
  const created = await SAF.makeDirectoryAsync(parent, name)
  const actual = documentName(created)
  if (
    actual.toLowerCase() !== name.toLowerCase() ||
    !isChildUri(parent, created, actual) ||
    entries.some((entry) => entry.uri === created)
  ) {
    throw new Error(
      `The document provider created "${actual}" instead of "${name}". Nothing was written.`
    )
  }
  rememberOutput(cache, parent, created)
  return created
}

async function ensureVaultPdf(
  parent: string,
  name: string,
  context: string,
  cache?: OutputListings
): Promise<string> {
  return ensureVaultFile(parent, name, context, 'application/pdf', 'PDF filename', cache)
}

async function ensureVaultFile(
  parent: string,
  name: string,
  context: string,
  mimeType: string,
  kind: string,
  cache?: OutputListings
): Promise<string> {
  const entries = await outputEntries(parent, name, context, cache)
  const matches = entries
  if (matches.length > 1) {
    throw new Error(`Cannot write "${context}": more than one "${name}" file exists.`)
  }
  const existing = matches[0]
  if (existing) {
    if (existing.info.isDirectory) {
      throw new Error(`Cannot write "${context}": "${existing.name}" is a directory, not a file.`)
    }
    return existing.uri
  }
  const created = await SAF.createFileAsync(parent, name, mimeType)
  const actual = documentName(created)
  if (
    actual.toLowerCase() !== name.toLowerCase() ||
    !isChildUri(parent, created, actual) ||
    entries.some((entry) => entry.uri === created)
  ) {
    throw new Error(
      `The document provider did not create the requested ${kind} "${name}". Nothing was written.`
    )
  }
  rememberOutput(cache, parent, created)
  return created
}

function noteDirectorySegments(directory: string): string[] {
  if (directory === '') return []
  if (
    directory.startsWith('/') ||
    directory.endsWith('/') ||
    directory.includes('\\') ||
    /[\p{Cc}]/u.test(directory)
  ) {
    throw new Error(`Cannot create a note in "${directory}": the folder path is not safe.`)
  }
  const segments = directory.split('/')
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.startsWith('.') ||
      noteExcludedDirectories.has(segment.toLowerCase())
    ) {
      throw new Error(`Cannot create a note in "${directory}": the folder path is not safe.`)
    }
  }
  return segments
}

async function resolveNoteDirectory(
  vault: Vault,
  segments: string[],
  action = 'create a note in'
): Promise<{ uri: string; path: string }> {
  let uri = vault.uri
  let path = ''
  for (const segment of segments) {
    const entries = await listedEntries(
      uri,
      path || vault.name,
      true,
      'full',
      (name) => name.toLowerCase() === segment.toLowerCase()
    )
    const matches = entries.filter(
      (entry) => entry.info.isDirectory && entry.name.toLowerCase() === segment.toLowerCase()
    )
    if (matches.length > 1) {
      throw new Error(
        `Cannot ${action} "${segments.join('/')}": more than one "${segment}" folder exists.`
      )
    }
    const match = matches[0]
    if (!match) {
      throw new Error(`Cannot ${action} "${segments.join('/')}": the folder does not exist.`)
    }
    path = path ? `${path}/${match.name}` : match.name
    uri = match.uri
  }
  return { uri, path }
}

export async function listNoteDirectories(vault: Vault): Promise<string[]> {
  const directories = ['']
  const pending = [{ uri: vault.uri, path: '' }]
  const seen = new Set<string>()
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index]
    if (seen.has(directory.uri)) {
      throw new Error(`Cannot list note folders: repeated directory at "${directory.path}".`)
    }
    seen.add(directory.uri)
    const entries = await listedEntries(
      directory.uri,
      directory.path || vault.name,
      true,
      'directories'
    )
    for (const entry of entries) {
      if (!entry.info.isDirectory || entry.name.startsWith('.')) continue
      if (noteExcludedDirectories.has(entry.name.toLowerCase())) continue
      const path = directory.path ? `${directory.path}/${entry.name}` : entry.name
      directories.push(path)
      pending.push({ uri: entry.uri, path })
    }
  }
  return directories.sort((a, b) => a.localeCompare(b))
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

// Reading the selection is cheap and local. Checking that the provider still
// grants access costs a round trip, so launch reads first and lets the index
// scan surface an access error instead of blocking the first frame on it.
export async function readSavedVault(): Promise<Vault | null> {
  const path = selectionPath()
  try {
    const selection = new File(path)
    if (!selection.exists) return null
    return validateVault(JSON.parse(selection.textSync()))
  } catch (error) {
    throw new Error(`Cannot load the saved vault: ${message(error)}`)
  }
}

export async function loadSavedVault(): Promise<Vault | null> {
  const vault = await readSavedVault()
  if (!vault) return null
  try {
    // Listing through the native module is one bridge call. The SAF fallback
    // marshals every entry into JS.
    if ((await listVaultEntries(vault.uri)) === null) await SAF.readDirectoryAsync(vault.uri)
  } catch (error) {
    throw new Error(`Cannot access the saved vault. Choose the folder again: ${message(error)}`)
  }
  return vault
}

export async function forgetVault(): Promise<void> {
  await FileSystem.deleteAsync(selectionPath(), { idempotent: true })
}

export type VaultLibrary = {
  notes: Note[]
  folders: string[]
  skipped: string[]
}

async function readNoteSource(uri: string, cancelled: () => boolean): Promise<string> {
  try {
    return await (readVaultText(uri) ?? new File(uri).text())
  } catch (error) {
    if (cancelled()) throw error
    // A sync client replacing a file can make one read fail and the next succeed.
    await new Promise((resolve) => setTimeout(resolve, 150))
    return await (readVaultText(uri) ?? new File(uri).text())
  }
}

export async function scanVault(
  vault: Vault,
  onProgress?: (count: number) => void,
  cancelled: () => boolean = () => false,
  onBatch?: (notes: Note[], folders: string[]) => void
): Promise<Note[]> {
  return (await scanVaultLibrary(vault, onProgress, cancelled, onBatch)).notes
}

export async function scanVaultLibrary(
  vault: Vault,
  onProgress?: (count: number) => void,
  cancelled: () => boolean = () => false,
  onBatch?: (notes: Note[], folders: string[]) => void
): Promise<VaultLibrary> {
  const notes: Note[] = []
  const folders = new Set<string>([''])
  const skipped: string[] = []
  const pdfs = new Map<string, string>()
  const hashes = new Map<string, string>()
  const pending = [{ uri: vault.uri, path: '', output: false }]
  const outputs: typeof pending = []
  const seen = new Set<string>()
  let publishedNotes = 0
  let publishedFolders = 0
  let sortedNotes: Note[] = []
  let lastBatch = 0
  const publish = () => {
    if (!onBatch) return
    if (publishedNotes === notes.length && publishedFolders === folders.size) return
    if (publishedNotes !== notes.length) {
      sortedNotes = [...notes].sort((a, b) => a.path.localeCompare(b.path))
      publishedNotes = notes.length
    }
    onBatch(
      sortedNotes,
      [...folders].sort((a, b) => a.localeCompare(b))
    )
    publishedFolders = folders.size
    lastBatch = performance.now()
  }
  for (let index = 0; index < pending.length || outputs.length; index++) {
    if (cancelled()) throw new Error('Indexing cancelled.')
    if (index === pending.length) {
      publish()
      pending.push(...outputs.splice(0))
    }
    const directory = pending[index]
    if (seen.has(directory.uri)) {
      throw new Error(`Cannot index the vault: repeated directory at "${directory.path}".`)
    }
    seen.add(directory.uri)
    if (!directory.output) {
      const before = folders.size
      folders.add(directory.path)
      // An empty folder is still a folder: show it while the scan runs instead
      // of waiting for a note that may never come. Coalesce the batches so a
      // folder-heavy vault does not copy and sort the list for every folder.
      if (folders.size !== before && performance.now() - lastBatch >= 50) publish()
    }
    try {
      const entries = await listVaultEntries(directory.uri)
      const uris = entries
        ? entries.map((entry) => entry.uri)
        : await SAF.readDirectoryAsync(directory.uri)
      const metadata = new Map(entries?.map((entry) => [entry.uri, entry]))
      // The filesystem fallback crosses the React Native bridge for every read, so a
      // smaller batch keeps the JS thread responsive on large vaults.
      await boundedMap(
        uris,
        async (uri) => {
          if (cancelled()) throw new Error('Indexing cancelled.')
          const name = documentName(uri)
          if (name.startsWith('.')) return
          const lower = name.toLowerCase()
          if (!directory.output && lower !== 'out' && noteExcludedDirectories.has(lower)) return
          const path = directory.path ? `${directory.path}/${name}` : name
          if (
            !directory.output &&
            /\.typ$/iu.test(name) &&
            metadata.get(uri)?.isDirectory !== true
          ) {
            try {
              const source = await readNoteSource(uri, cancelled)
              if (cancelled()) throw new Error('Indexing cancelled.')
              notes.push({
                uri,
                path,
                source,
                title: extractTitle(source, name),
                modifiedAt: modifiedAt(metadata.get(uri) ?? {}),
              })
              onProgress?.(notes.length)
              if (notes.length === 1 || performance.now() - lastBatch >= 50) publish()
            } catch (error) {
              if (cancelled()) throw error
              if (new Directory(uri).exists) {
                pending.push({ uri, path, output: false })
                return
              }
              // One unreadable note must not hide the rest of the vault.
              skipped.push(path)
              return
            }
            return
          }
          if (metadata.get(uri)?.isDirectory ?? new Directory(uri).exists) {
            if (directory.output) pending.push({ uri, path, output: true })
            else if (directory.path === '' && lower === 'out') {
              outputs.push({ uri, path: '', output: true })
            } else if (!noteExcludedDirectories.has(lower))
              pending.push({ uri, path, output: false })
          } else if (directory.output && /\.pdf$/iu.test(name)) {
            pdfs.set(path.replace(/\.pdf$/iu, '.pdf'), uri)
          } else if (directory.output && /\.sha256$/iu.test(name) && path.startsWith('hashes/')) {
            const stem = path.slice('hashes/'.length, -'.sha256'.length)
            try {
              const value = (await readNoteSource(uri, cancelled)).trim().toLowerCase()
              if (/^[0-9a-f]{64}$/u.test(value)) hashes.set(stem, value)
            } catch (error) {
              if (cancelled()) throw error
              // A missing or unreadable hash leaves the PDF stale.
            }
          }
        },
        entries ? IO_CONCURRENCY : 8
      )
    } catch (error) {
      throw new Error(
        `Cannot index "${directory.path || (directory.output ? 'out' : vault.name)}": ${message(error)}`
      )
    }
  }
  // A coalesced folder batch can be the last thing the scan does.
  publish()
  return {
    notes: notes
      .map((note) => {
        const stem = note.path.replace(/\.typ$/iu, '')
        const pdf = pdfs.get(`${stem}.pdf`)
        return pdf ? { ...note, pdfUri: pdf, pdfHash: hashes.get(stem) } : note
      })
      .sort((a, b) => a.path.localeCompare(b.path)),
    folders: [...folders].sort((a, b) => a.localeCompare(b)),
    skipped: skipped.sort((a, b) => a.localeCompare(b)),
  }
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

function newFolderName(value: string): string {
  const name = value.normalize('NFC').trim()
  if (!name) throw new Error('Give the folder a name.')
  if (
    name.startsWith('.') ||
    /[/\\:*?"<>|\p{Cc}]/u.test(name) ||
    name.endsWith('.') ||
    encodeURIComponent(name).replace(/%[A-F\d]{2}/gu, '_').length > 120
  ) {
    throw new Error('Use a folder name without slashes, hidden names, or filename punctuation.')
  }
  if (noteExcludedDirectories.has(name.toLowerCase())) {
    throw new Error(`The folder name "${name}" is reserved. Choose another name.`)
  }
  return name
}

export async function createFolder(
  vault: Vault,
  value: string,
  directory = ''
): Promise<NoteFolder> {
  const name = newFolderName(value)
  const segments = noteDirectorySegments(directory)
  const parent = await resolveNoteDirectory(vault, segments)
  const existing = await listedEntries(
    parent.uri,
    parent.path || vault.name,
    true,
    'full',
    (entry) => entry.toLowerCase() === name.toLowerCase()
  )
  const match = existing[0]
  if (match) {
    throw new Error(
      match.info.isDirectory
        ? `A folder named "${match.name}" already exists here.`
        : `A file named "${match.name}" already exists here.`
    )
  }
  const uri = await SAF.makeDirectoryAsync(parent.uri, name)
  const actual = documentName(uri)
  if (actual !== name || !isChildUri(parent.uri, uri, actual)) {
    throw new Error(
      `The document provider created "${actual}" instead of "${name}". Choose a different name.`
    )
  }
  return { path: parent.path ? `${parent.path}/${name}` : name, name }
}

function movableNoteName(path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    /[\p{Cc}]/u.test(path)
  ) {
    throw new Error('Cannot move this note: the note path is not safe.')
  }
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Cannot move this note: the note path is not safe.')
  }
  const name = segments.at(-1) ?? ''
  if (name.startsWith('.') || !/\.typ$/iu.test(name)) {
    throw new Error('Cannot move this note: only visible Typst notes can be moved.')
  }
  return name
}

export async function moveNoteToFolder(vault: Vault, note: Note, directory: string): Promise<Note> {
  const filename = movableNoteName(note.path)
  const segments = noteDirectorySegments(directory)
  const parent = await resolveNoteDirectory(vault, segments)
  const currentParent = note.path.includes('/')
    ? note.path.slice(0, note.path.lastIndexOf('/'))
    : ''
  if (parent.path === currentParent) {
    throw new Error(`This note is already in "${parent.path || vault.name}".`)
  }
  const existing = await listedEntries(
    parent.uri,
    parent.path || vault.name,
    true,
    'full',
    (entry) => entry.toLowerCase() === filename.toLowerCase()
  )
  if (existing.length) {
    throw new Error(
      `A file named "${existing[0].name}" already exists in "${parent.path || vault.name}".`
    )
  }
  const source = await FileSystem.readAsStringAsync(note.uri)
  const uri = await SAF.createFileAsync(parent.uri, filename, 'application/octet-stream')
  const actual = documentName(uri)
  if (
    actual !== filename ||
    !isChildUri(parent.uri, uri, actual) ||
    existing.some((entry) => entry.uri === uri)
  ) {
    throw new Error('The document provider did not create the requested moved filename.')
  }
  try {
    await writeSource(uri, source)
    if ((await FileSystem.readAsStringAsync(uri)) !== source) {
      throw new Error('The moved copy could not be verified.')
    }
    await FileSystem.deleteAsync(note.uri, { idempotent: false })
  } catch (cause) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
    throw new Error(`Cannot move "${note.path}": ${message(cause)}`)
  }
  return {
    ...note,
    uri,
    path: parent.path ? `${parent.path}/${filename}` : filename,
    title: extractTitle(source, filename),
    source,
    modifiedAt: null,
    pdfUri: undefined,
    pdfHash: undefined,
  }
}

export async function createNote(
  vault: Vault,
  title: string,
  body: string,
  directory = '',
  template?: string
): Promise<Note> {
  const segments = noteDirectorySegments(directory)
  const filename = noteFilename(title)
  if (!segments.length && filename === 'template.typ') {
    throw new Error(
      'The name "template.typ" is reserved for the vault template. Choose another title.'
    )
  }
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
  const source = buildNoteSource(title, body, template)
  const parent = await resolveNoteDirectory(vault, segments)
  const existing = await listedEntries(
    parent.uri,
    parent.path || vault.name,
    true,
    'full',
    (name) => name.toLowerCase() === filename.toLowerCase()
  )
  if (existing.some((entry) => entry.name.toLowerCase() === filename.toLowerCase())) {
    throw new Error(`A file named "${filename}" already exists. Choose a different title.`)
  }
  // A text/plain MIME type can cause Android providers to append an unwanted .txt extension.
  const uri = await SAF.createFileAsync(parent.uri, filename, 'application/octet-stream')
  const actual = documentName(uri)
  if (
    actual !== filename ||
    !isChildUri(parent.uri, uri, actual) ||
    existing.some((entry) => entry.uri === uri)
  ) {
    throw new Error(
      'The document provider did not create the requested new filename. Nothing was written.'
    )
  }
  await writeSource(uri, source)
  return {
    uri,
    path: parent.path ? `${parent.path}/${filename}` : filename,
    title: extractTitle(source, filename),
    source,
    modifiedAt: modifiedAt(await entryInfo(uri)),
  }
}

function notePathSegments(path: string): string[] {
  if (
    !path ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    /[\p{Cc}]/u.test(path)
  ) {
    throw new Error('Cannot move this note to trash: the path is not safe.')
  }
  const segments = path.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.startsWith('.')) {
      throw new Error('Cannot move this note to trash: the path is not safe.')
    }
  }
  if (!/\.typ$/iu.test(segments.at(-1) ?? '')) {
    throw new Error('Cannot move this note to trash: only Typst notes can be trashed.')
  }
  return segments
}

async function ensureTrashRoot(vault: Vault): Promise<string> {
  const entries = await listedEntries(
    vault.uri,
    vault.name,
    false,
    'full',
    (name) => name.toLowerCase() === '.trash'
  )
  if (entries.length > 1) {
    throw new Error('Cannot move this note to trash: more than one ".trash" folder exists.')
  }
  const existing = entries[0]
  if (existing) {
    if (!existing.info.isDirectory) {
      throw new Error('Cannot move this note to trash: ".trash" is a file, not a folder.')
    }
    return existing.uri
  }
  const created = await SAF.makeDirectoryAsync(vault.uri, '.trash')
  const actual = documentName(created)
  if (
    actual.toLowerCase() !== '.trash' ||
    !isChildUri(vault.uri, created, actual) ||
    entries.some((entry) => entry.uri === created)
  ) {
    throw new Error('The document provider did not create the requested trash folder.')
  }
  return created
}

async function trashDestination(
  parent: string,
  path: string,
  name: string
): Promise<{ name: string; matches: ListedEntry[] }> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate =
      attempt === 0 ? name : `${stem}.${stamp}${attempt === 1 ? '' : `-${attempt}`}${extension}`
    const matches = await outputEntries(parent, candidate, `${path}/${candidate}`)
    if (!matches.length) return { name: candidate, matches }
  }
  throw new Error(`Cannot move this note to trash: no available name in "${path}".`)
}

export async function trashNote(vault: Vault, note: Note): Promise<TrashedNote> {
  const segments = notePathSegments(note.path)
  const source = await FileSystem.readAsStringAsync(note.uri)
  let parent = await ensureTrashRoot(vault)
  let path = '.trash'
  for (const segment of segments.slice(0, -1)) {
    parent = await ensureVaultDirectory(parent, segment, `${path}/${segment}`)
    path = `${path}/${segment}`
  }
  const destination = await trashDestination(parent, path, segments.at(-1) ?? '')
  const uri = await SAF.createFileAsync(parent, destination.name, 'application/octet-stream')
  const actual = documentName(uri)
  if (
    actual.toLowerCase() !== destination.name.toLowerCase() ||
    !isChildUri(parent, uri, actual) ||
    destination.matches.some((entry) => entry.uri === uri)
  ) {
    throw new Error('The document provider did not create the requested trash filename.')
  }
  let removing = false
  try {
    await writeSource(uri, source)
    if ((await FileSystem.readAsStringAsync(uri)) !== source) {
      throw new Error('The trash copy could not be verified.')
    }
    removing = true
    try {
      await FileSystem.deleteAsync(note.uri, { idempotent: false })
    } catch (cause) {
      // A provider can report a delete failure after removing the document, so
      // only drop the trash copy when the source is confirmed present. An
      // unknown answer keeps the trash copy instead of risking the note.
      const exists = await FileSystem.getInfoAsync(note.uri)
        .then((info) => info.exists)
        .catch(() => undefined)
      if (exists !== false) {
        if (exists) removing = false
        throw cause
      }
    }
  } catch (cause) {
    if (!removing) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Cannot move "${note.path}" to trash: ${message}`)
  }
  return { uri, path: `${path}/${destination.name}` }
}

export type MovedFolder = {
  path: string
  notes: { uri: string; nextUri: string }[]
}

function folderPathSegments(path: string): string[] {
  if (
    !path ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    /[\p{Cc}]/u.test(path)
  ) {
    throw new Error('Cannot move this folder: the folder path is not safe.')
  }
  const segments = path.split('/')
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.startsWith('.') ||
      noteExcludedDirectories.has(segment.toLowerCase())
    ) {
      throw new Error('Cannot move this folder: the folder path is not safe.')
    }
  }
  return segments
}

async function copyVaultFile(source: string, destination: string): Promise<void> {
  const base64 = await FileSystem.readAsStringAsync(source, { encoding: 'base64' })
  await FileSystem.writeAsStringAsync(destination, base64, { encoding: 'base64' })
  const written = await FileSystem.readAsStringAsync(destination, { encoding: 'base64' })
  if (written !== base64) throw new Error('The copied file could not be verified.')
}

async function copyVaultTree(
  source: string,
  destination: string,
  context: string,
  relative = '',
  copied: MovedFolder['notes'] = []
): Promise<MovedFolder['notes']> {
  const entries = await listedEntries(source, context, false, 'full')
  const excluded = relative
    .split('/')
    .some((segment) => noteExcludedDirectories.has(segment.toLowerCase()))
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.info.isDirectory) {
      const created = await SAF.makeDirectoryAsync(destination, entry.name)
      const actual = documentName(created)
      if (actual !== entry.name || !isChildUri(destination, created, actual)) {
        throw new Error(`The document provider did not create "${entry.name}" during the copy.`)
      }
      await copyVaultTree(entry.uri, created, `${context}/${entry.name}`, path, copied)
      continue
    }
    const created = await SAF.createFileAsync(destination, entry.name, 'application/octet-stream')
    const actual = documentName(created)
    if (actual !== entry.name || !isChildUri(destination, created, actual)) {
      throw new Error(`The document provider did not create "${entry.name}" during the copy.`)
    }
    await copyVaultFile(entry.uri, created)
    if (!excluded && !entry.name.startsWith('.') && /\.typ$/iu.test(entry.name)) {
      copied.push({ uri: entry.uri, nextUri: created })
    }
  }
  return copied
}

async function newFolderAt(parent: { uri: string; path: string }, name: string): Promise<string> {
  const existing = await outputEntries(parent.uri, name, `${parent.path || 'notes'}/${name}`)
  if (existing.length) {
    throw new Error(
      existing[0].info.isDirectory
        ? `A folder named "${existing[0].name}" already exists here.`
        : `A file named "${existing[0].name}" already exists here.`
    )
  }
  const created = await SAF.makeDirectoryAsync(parent.uri, name)
  const actual = documentName(created)
  if (actual !== name || !isChildUri(parent.uri, created, actual)) {
    throw new Error(`The document provider created "${actual}" instead of "${name}".`)
  }
  return created
}

export async function moveFolderToFolder(
  vault: Vault,
  path: string,
  directory: string
): Promise<MovedFolder> {
  const segments = folderPathSegments(path)
  const source = await resolveNoteDirectory(vault, segments, 'move this folder')
  const target = await resolveNoteDirectory(
    vault,
    noteDirectorySegments(directory),
    'move this folder'
  )
  const currentParent = segments.length > 1 ? segments.slice(0, -1).join('/') : ''
  if (target.path === currentParent) {
    throw new Error(`This folder is already in "${target.path || vault.name}".`)
  }
  if (target.path === source.path || target.path.startsWith(`${source.path}/`)) {
    throw new Error('A folder cannot be moved inside itself.')
  }
  const name = segments.at(-1) ?? ''
  const created = await newFolderAt(target, name)
  let notes: MovedFolder['notes']
  let removing = false
  try {
    notes = await copyVaultTree(source.uri, created, source.path)
    removing = true
    await FileSystem.deleteAsync(source.uri, { idempotent: false })
  } catch (cause) {
    if (!removing) await FileSystem.deleteAsync(created, { idempotent: true }).catch(() => {})
    throw new Error(`Cannot move "${source.path}": ${message(cause)}`)
  }
  return { path: target.path ? `${target.path}/${name}` : name, notes }
}

async function trashFolderName(parent: string, path: string, name: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? name : `${name}.${stamp}${attempt === 1 ? '' : `-${attempt}`}`
    const matches = await outputEntries(parent, candidate, `${path}/${candidate}`)
    if (!matches.length) return candidate
  }
  throw new Error(`Cannot move this folder to trash: no available name in "${path}".`)
}

export async function trashFolder(vault: Vault, path: string): Promise<TrashedNote> {
  const segments = folderPathSegments(path)
  const source = await resolveNoteDirectory(vault, segments, 'move this folder to trash')
  let parent = await ensureTrashRoot(vault)
  let trashPath = '.trash'
  for (const segment of segments.slice(0, -1)) {
    parent = await ensureVaultDirectory(parent, segment, `${trashPath}/${segment}`)
    trashPath = `${trashPath}/${segment}`
  }
  const destination = await trashFolderName(parent, trashPath, segments.at(-1) ?? '')
  const created = await SAF.makeDirectoryAsync(parent, destination)
  const actual = documentName(created)
  if (actual.toLowerCase() !== destination.toLowerCase() || !isChildUri(parent, created, actual)) {
    await FileSystem.deleteAsync(created, { idempotent: true }).catch(() => {})
    throw new Error('The document provider did not create the requested trash folder.')
  }
  let removing = false
  try {
    await copyVaultTree(source.uri, created, source.path)
    removing = true
    // A folder delete is not atomic: part of the tree can be gone before the
    // provider reports a failure, so the trash copy always stays on error.
    await FileSystem.deleteAsync(source.uri, { idempotent: false })
  } catch (cause) {
    if (!removing) await FileSystem.deleteAsync(created, { idempotent: true }).catch(() => {})
    throw new Error(`Cannot move "${source.path}" to trash: ${message(cause)}`)
  }
  return { uri: created, path: `${trashPath}/${destination}` }
}

export async function restoreNote(
  vault: Vault,
  trashed: TrashedNote,
  originalPath: string
): Promise<Note> {
  const segments = notePathSegments(originalPath)
  const filename = segments.at(-1) ?? ''
  const parent = await resolveNoteDirectory(vault, segments.slice(0, -1), 'restore a note into')
  const existing = await listedEntries(
    parent.uri,
    parent.path || vault.name,
    false,
    'full',
    (name) => name.toLowerCase() === filename.toLowerCase()
  )
  if (existing.length) {
    throw new Error(`Cannot restore "${originalPath}": a file with that name already exists.`)
  }
  const source = await FileSystem.readAsStringAsync(trashed.uri)
  const uri = await SAF.createFileAsync(parent.uri, filename, 'application/octet-stream')
  const actual = documentName(uri)
  if (
    actual !== filename ||
    !isChildUri(parent.uri, uri, actual) ||
    existing.some((entry) => entry.uri === uri)
  ) {
    throw new Error(
      `Cannot restore "${originalPath}": the document provider did not create the requested filename.`
    )
  }
  try {
    await writeSource(uri, source)
    if ((await FileSystem.readAsStringAsync(uri)) !== source) {
      throw new Error('The restored copy could not be verified.')
    }
  } catch (cause) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
    throw new Error(`Cannot restore "${originalPath}": ${message(cause)}`)
  }
  await FileSystem.deleteAsync(trashed.uri, { idempotent: true }).catch(() => {})
  return {
    path: originalPath,
    uri,
    title: extractTitle(source, filename),
    source,
    modifiedAt: null,
  }
}

export async function restoreFolder(
  vault: Vault,
  trashed: TrashedNote,
  originalPath: string
): Promise<void> {
  const segments = folderPathSegments(originalPath)
  const name = segments.at(-1) ?? ''
  const parent = await resolveNoteDirectory(vault, segments.slice(0, -1), 'restore a folder into')
  const existing = await listedEntries(
    parent.uri,
    parent.path || vault.name,
    false,
    'full',
    (entry) => entry.toLowerCase() === name.toLowerCase()
  )
  if (existing.length) {
    throw new Error(`Cannot restore "${originalPath}": a folder with that name already exists.`)
  }
  const created = await SAF.makeDirectoryAsync(parent.uri, name)
  const actual = documentName(created)
  if (actual.toLowerCase() !== name.toLowerCase() || !isChildUri(parent.uri, created, actual)) {
    await FileSystem.deleteAsync(created, { idempotent: true }).catch(() => {})
    throw new Error(
      `Cannot restore "${originalPath}": the document provider did not create the requested folder.`
    )
  }
  try {
    await copyVaultTree(trashed.uri, created, originalPath)
  } catch (cause) {
    await FileSystem.deleteAsync(created, { idempotent: true }).catch(() => {})
    throw new Error(`Cannot restore "${originalPath}": ${message(cause)}`)
  }
  await FileSystem.deleteAsync(trashed.uri, { idempotent: true }).catch(() => {})
}

export async function readNote(note: Note): Promise<Note> {
  const source = await FileSystem.readAsStringAsync(note.uri)
  if (source === note.source) return note
  return {
    ...note,
    source,
    title: extractTitle(source, note.path.slice(note.path.lastIndexOf('/') + 1)),
    modifiedAt: null,
    pdfHash: undefined,
  }
}

export async function saveNote(note: Note, source: string): Promise<Note> {
  if (isRootTemplate(note.path)) validateNoteTemplate(source)
  const current = await FileSystem.readAsStringAsync(note.uri)
  if (current !== note.source) {
    throw new Error(
      `Cannot save "${note.path}": the file changed outside this editor, possibly through Syncthing. Return to the notes list and reopen it before saving to avoid overwriting those changes.`
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

async function pruneSourceCache(directory: string): Promise<void> {
  const names = await FileSystem.readDirectoryAsync(directory)
  const sessions = names.flatMap((raw) => {
    const name = raw.replace(/\/$/u, '')
    const match = /^src-([a-z0-9]+)-([a-z0-9]+)$/u.exec(name)
    if (!match) return []
    return [{ name, time: Number.parseInt(match[1], 36), sequence: Number.parseInt(match[2], 36) }]
  })
  sessions.sort((a, b) => b.time - a.time || b.sequence - a.sequence)
  const now = Date.now()
  await Promise.all(
    sessions
      .filter(
        (session, index) =>
          index >= SOURCE_CACHE_SESSIONS - 1 || now - session.time > SOURCE_CACHE_MAX_AGE
      )
      .map((session) =>
        FileSystem.deleteAsync(`${directory}${session.name}`, { idempotent: true }).catch(() => {})
      )
  )
}

export async function prepareSource(note: Note, source: string): Promise<string> {
  const basename = sourceFilename(note.path)
  if (!FileSystem.cacheDirectory) throw new Error('Private cache storage is unavailable.')
  const directory = `${FileSystem.cacheDirectory}typo-sources/`
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
  await pruneSourceCache(directory)
  let session: string
  do {
    session = `${directory}src-${Date.now().toString(36)}-${(++pdfSequence).toString(36)}`
  } while ((await FileSystem.getInfoAsync(session)).exists)
  const destination = `${session}/${encodeURIComponent(basename)}`
  try {
    await FileSystem.makeDirectoryAsync(session)
    await FileSystem.writeAsStringAsync(destination, source)
  } catch (error) {
    await FileSystem.deleteAsync(session, { idempotent: true }).catch(() => {})
    throw new Error(`Cannot prepare "${basename}" for sharing: ${message(error)}`)
  }
  return destination
}

async function rootTemplate(vault: Vault): Promise<ListedEntry | undefined> {
  let entries: ListedEntry[]
  try {
    entries = await listedEntries(
      vault.uri,
      vault.name,
      true,
      'full',
      (name) => name.toLowerCase() === 'template.typ'
    )
  } catch (error) {
    throw new Error(`Cannot read the note template: ${message(error)}`)
  }
  if (entries.length > 1) {
    throw new Error('Cannot read the note template: more than one template.typ file exists.')
  }
  return entries[0]
}

export async function readTemplate(vault: Vault): Promise<string> {
  const entry = await rootTemplate(vault)
  if (!entry) return DEFAULT_TEMPLATE
  if (entry.info.isDirectory) {
    throw new Error('Cannot read the note template: template.typ is a folder.')
  }
  try {
    return await FileSystem.readAsStringAsync(entry.uri)
  } catch (error) {
    throw new Error(`Cannot read the note template: ${message(error)}`)
  }
}

export async function saveTemplate(vault: Vault, source: string, expected?: string): Promise<void> {
  validateNoteTemplate(source)
  const entry = await rootTemplate(vault)
  if (!entry) {
    const uri = await SAF.createFileAsync(vault.uri, 'template.typ', 'application/octet-stream')
    const actual = documentName(uri)
    if (actual !== 'template.typ' || !isChildUri(vault.uri, uri, actual)) {
      throw new Error('The document provider did not create template.typ. Nothing was written.')
    }
    try {
      await writeSource(uri, source)
    } catch (cause) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
      throw new Error(`Cannot save the note template: ${message(cause)}`)
    }
    return
  }
  if (entry.info.isDirectory) {
    throw new Error('Cannot save the note template: template.typ is a folder.')
  }
  if (expected !== undefined && (await FileSystem.readAsStringAsync(entry.uri)) !== expected) {
    throw new Error('The note template changed outside this editor. Reopen it before saving.')
  }
  await writeSource(entry.uri, source)
}

export async function loadCompileFiles(
  vault: Vault,
  cache?: CompileFileCache
): Promise<CompileFile[]> {
  const collected: { uri: string; path: string; size?: number; stamp?: string }[] = []
  const pending = [{ uri: vault.uri, path: '' }]
  const seen = new Set<string>()
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index]
    if (seen.has(directory.uri)) {
      throw new Error(`Cannot collect compiler files: repeated directory at "${directory.path}".`)
    }
    seen.add(directory.uri)
    const entries = await listedEntries(
      directory.uri,
      directory.path || vault.name,
      true,
      'compile'
    )
    for (const entry of entries) {
      const path = directory.path ? `${directory.path}/${entry.name}` : entry.name
      if (entry.name.startsWith('.')) continue
      const lower = entry.name.toLowerCase()
      if (entry.info.isDirectory) {
        if (directory.path === '' && compileExcludedDirectories.has(lower)) continue
        pending.push({ uri: entry.uri, path })
        continue
      }
      if (!compileExtensions.has(extensionOf(entry.name))) continue
      if (
        path.startsWith('/') ||
        path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      ) {
        throw new Error(`Cannot collect compiler files: unsafe path "${path}".`)
      }
      collected.push({
        uri: entry.uri,
        path,
        size: entry.info.size,
        stamp: listingStamp(entry.info),
      })
    }
  }
  let knownTotal = 0
  for (const file of collected) {
    if (typeof file.size !== 'number') continue
    if (file.size > MAX_COMPILE_FILE) {
      throw new Error(
        `Cannot collect compiler files: "${file.path}" is ${formatMiB(file.size)} MiB, above the ${formatMiB(MAX_COMPILE_FILE)} MiB per-file limit.`
      )
    }
    knownTotal += file.size
  }
  if (knownTotal > MAX_COMPILE_TOTAL) {
    throw new Error(
      `Cannot collect compiler files: ${formatMiB(knownTotal)} MiB exceeds the ${formatMiB(MAX_COMPILE_TOTAL)} MiB total limit.`
    )
  }
  let actualTotal = 0
  let reused = true
  const now = Date.now()
  const files = await boundedMap(
    collected,
    async (file) => {
      const known = cache?.entries.get(file.path)
      if (
        known &&
        known.uri === file.uri &&
        file.stamp !== undefined &&
        known.stamp === file.stamp &&
        now - known.readAt < COMPILE_STAMP_MAX_AGE
      ) {
        actualTotal += known.size
        return known.file
      }
      reused = false
      const read = () => readVaultBase64(file.uri, MAX_COMPILE_FILE) ?? new File(file.uri).base64()
      const limited = (error: unknown) =>
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ERR_TYPO_VAULT_FILE_LIMIT'
      let base64: string
      try {
        try {
          base64 = await read()
        } catch (error) {
          if (limited(error)) throw error
          // A sync client replacing a file can make one read fail and the next succeed.
          await new Promise((resolve) => setTimeout(resolve, 150))
          base64 = await read()
        }
      } catch (error) {
        if (limited(error)) {
          throw new Error(
            `Cannot collect compiler files: "${file.path}" exceeds the ${formatMiB(MAX_COMPILE_FILE)} MiB per-file limit.`
          )
        }
        throw new Error(`Cannot read compiler input "${file.path}": ${message(error)}`)
      }
      const size = decodedSize(base64)
      if (size > MAX_COMPILE_FILE) {
        throw new Error(
          `Cannot collect compiler files: "${file.path}" is ${formatMiB(size)} MiB, above the ${formatMiB(MAX_COMPILE_FILE)} MiB per-file limit.`
        )
      }
      actualTotal += size
      if (actualTotal > MAX_COMPILE_TOTAL) {
        throw new Error(
          `Cannot collect compiler files: ${formatMiB(actualTotal)} MiB exceeds the ${formatMiB(MAX_COMPILE_TOTAL)} MiB total limit.`
        )
      }
      const compiled = { path: file.path, base64 }
      cache?.entries.set(file.path, {
        uri: file.uri,
        stamp: file.stamp ?? '',
        size,
        readAt: now,
        file: compiled,
      })
      return compiled
    },
    COMPILE_READ_CONCURRENCY
  )
  files.sort((a, b) => a.path.localeCompare(b.path))
  if (!cache) return files
  const previous = cache.files
  // Reuse the array itself so unchanged refreshes stay free for callers that
  // compare snapshots by identity.
  if (
    reused &&
    previous &&
    previous.length === files.length &&
    files.every((file, index) => previous[index] === file)
  )
    return previous
  cache.files = files
  if (cache.entries.size > files.length) {
    const paths = new Set(files.map((file) => file.path))
    for (const path of cache.entries.keys()) if (!paths.has(path)) cache.entries.delete(path)
  }
  return files
}

export function createPdfWriter(vault: Vault) {
  const listings: OutputListings = new Map()
  return {
    write: (note: Note, base64: string) => writeCompiledPdf(vault, note, base64, listings),
    hash: (note: Note) => writePdfHash(vault, note, listings),
  }
}

export async function writePdfHash(
  vault: Vault,
  note: Note,
  listings?: OutputListings
): Promise<void> {
  const output = pdfOutput(note.path)
  const root = await ensureVaultDirectory(vault.uri, 'out', vault.name, listings)
  await writeHashFile(root, output, `${sha256(note.source)}\n`, listings)
}

async function writeHashFile(
  root: string,
  output: { directories: string[]; filename: string; path: string },
  value: string,
  listings?: OutputListings
): Promise<void> {
  let parent = await ensureVaultDirectory(root, 'hashes', `${output.path} hash`, listings)
  for (const directory of output.directories) {
    parent = await ensureVaultDirectory(parent, directory, `${output.path} hash`, listings)
  }
  const name = output.filename.replace(/\.pdf$/iu, '.sha256')
  const uri = await ensureVaultFile(
    parent,
    name,
    `${output.path} hash`,
    'application/octet-stream',
    'hash filename',
    listings
  )
  try {
    if ((await FileSystem.readAsStringAsync(uri)) === value) return
  } catch {
    // A missing or unreadable hash is rewritten.
  }
  await writeSource(uri, value)
}

export async function writeCompiledPdf(
  vault: Vault,
  note: Note,
  pdfBase64: string,
  listings?: OutputListings
): Promise<string> {
  const output = pdfOutput(note.path)
  assertPdfBase64(pdfBase64)
  if (!FileSystem.cacheDirectory) throw new Error('Private cache storage is unavailable.')
  const staging = `${FileSystem.cacheDirectory}typo-pdf-${Date.now()}-${++pdfSequence}.tmp`
  try {
    let bytes: Uint8Array
    try {
      await FileSystem.writeAsStringAsync(staging, pdfBase64, { encoding: 'base64' })
      bytes = await new File(staging).bytes()
    } catch (error) {
      throw new Error(`Cannot decode the compiled PDF: ${message(error)}`)
    }
    if (bytes.length < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') {
      throw new Error(
        'The compiler returned data that is not a PDF (missing the %PDF- signature). The existing PDF was left unchanged.'
      )
    }
    let current: string
    try {
      current = await FileSystem.readAsStringAsync(note.uri)
    } catch (error) {
      throw new Error(
        `Cannot write the PDF for "${note.path}": cannot read the note: ${message(error)}`
      )
    }
    if (current !== note.source) {
      throw new Error(
        `Cannot write the PDF for "${note.path}": the note changed outside this editor, possibly through Syncthing. Reopen it and compile again; the existing PDF was left unchanged.`
      )
    }
    const root = await ensureVaultDirectory(vault.uri, 'out', vault.name, listings)
    // Invalidate the sidecar before replacing the PDF so a failed hash write cannot
    // leave an old hash matching the new PDF.
    await writeHashFile(root, output, '', listings)
    let parent = root
    for (const directory of output.directories) {
      parent = await ensureVaultDirectory(parent, directory, output.path, listings)
    }
    const destination = await ensureVaultPdf(parent, output.filename, output.path, listings)
    try {
      // SAF's ordinary write mode can leave old trailing bytes when a PDF gets shorter.
      const handle = new File(destination).open(FileMode.Truncate)
      try {
        await handle.writeBytes(bytes)
      } finally {
        handle.close()
      }
    } catch (error) {
      throw new Error(`Cannot write the compiled PDF to "${output.path}": ${message(error)}`)
    }
    await writeHashFile(root, output, `${sha256(note.source)}\n`, listings)
    return destination
  } catch (cause) {
    listings?.clear()
    throw cause
  } finally {
    await FileSystem.deleteAsync(staging, { idempotent: true }).catch(() => {})
  }
}

export async function preparePdf(note: Note): Promise<string> {
  if (!note.pdfUri) {
    throw new Error(
      'No current PDF is available for this note. Wait for compilation and try again.'
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
