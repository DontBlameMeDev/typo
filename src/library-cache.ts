import * as FileSystem from 'expo-file-system/legacy'
import { fingerprint } from './compiler/fingerprint'
import { parseVaultIndex, serializeVaultIndex } from './library-index'
import type { Note, Vault } from './types'

function location(vault: Vault) {
  if (!FileSystem.cacheDirectory) throw new Error('Private cache storage is unavailable.')
  const directory = `${FileSystem.cacheDirectory}typo-library/`
  return { directory, uri: `${directory}${fingerprint(vault.uri)}.json` }
}

export async function loadVaultIndex(vault: Vault): Promise<Note[] | null> {
  try {
    return parseVaultIndex(await FileSystem.readAsStringAsync(location(vault).uri), vault)
  } catch {
    return null
  }
}

export async function storeVaultIndex(vault: Vault, notes: Note[]): Promise<void> {
  const { directory, uri } = location(vault)
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
  await FileSystem.writeAsStringAsync(uri, serializeVaultIndex(vault, notes))
}
