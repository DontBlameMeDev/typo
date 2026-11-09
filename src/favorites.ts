import { File } from 'expo-file-system'
import * as FileSystem from 'expo-file-system/legacy'
import { fingerprint } from './compiler/fingerprint'
import type { Vault } from './types'

function location(vault: Vault) {
  if (!FileSystem.documentDirectory) throw new Error('Private document storage is unavailable.')
  const directory = `${FileSystem.documentDirectory}typo-favorites/`
  return { directory, uri: `${directory}${fingerprint(vault.uri)}.json` }
}

export async function loadFavorites(vault: Vault): Promise<string[]> {
  try {
    const value = JSON.parse(new File(location(vault).uri).textSync())
    if (value.version !== 1 || value.vault !== vault.uri || !Array.isArray(value.favorites))
      return []
    return value.favorites.filter((path: unknown): path is string => typeof path === 'string')
  } catch {
    return []
  }
}

export async function storeFavorites(vault: Vault, favorites: string[]): Promise<void> {
  const { directory, uri } = location(vault)
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
  await FileSystem.writeAsStringAsync(
    uri,
    JSON.stringify({ version: 1, vault: vault.uri, favorites })
  )
}
