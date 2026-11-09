import { File } from 'expo-file-system'
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
    // The startup path reads the index synchronously: a bridge round trip costs
    // more than parsing a cache of this size.
    return parseVaultIndex(new File(location(vault).uri).textSync(), vault)
  } catch {
    return null
  }
}

export async function storeVaultIndex(vault: Vault, notes: Note[]): Promise<void> {
  const { directory, uri } = location(vault)
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
  // A launch that is killed while the cache is written must not leave a corrupt
  // file behind: the previous index stays readable until the new one is whole.
  const pending = `${uri}.writing`
  await FileSystem.writeAsStringAsync(pending, serializeVaultIndex(vault, notes))
  await FileSystem.deleteAsync(uri, { idempotent: true })
  await FileSystem.moveAsync({ from: pending, to: uri })
}
