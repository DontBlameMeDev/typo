import * as FileSystem from 'expo-file-system/legacy'
import { fingerprint } from './compiler/fingerprint'
import type { Note, Vault } from './types'

function location(vault: Vault) {
  if (!FileSystem.cacheDirectory) throw new Error('Private cache storage is unavailable.')
  const directory = `${FileSystem.cacheDirectory}typo-library/`
  return { directory, uri: `${directory}${fingerprint(vault.uri)}.json` }
}

export async function loadVaultIndex(vault: Vault): Promise<Note[] | null> {
  try {
    const value = JSON.parse(await FileSystem.readAsStringAsync(location(vault).uri))
    if (value.version !== 1 || value.vault !== vault.uri || !Array.isArray(value.notes)) return null
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
  await FileSystem.writeAsStringAsync(uri, JSON.stringify({ version: 1, vault: vault.uri, notes }))
}
