import type { Note, Vault } from './types'

// The launch cache stores the whole library, sources and folders included, so
// the first frame matches the vault before the first scan finishes. Keep the
// format pure and free of native imports so benchmarks can measure the launch
// path.
const VERSION = 3

export type VaultIndex = {
  notes: Note[]
  folders: string[]
}

export function parseVaultIndex(text: string, vault: Vault): VaultIndex | null {
  try {
    const value = JSON.parse(text)
    if (value.version !== VERSION || value.vault !== vault.uri) return null
    if (!Array.isArray(value.notes) || !Array.isArray(value.folders)) return null
    if (!value.folders.every((path: unknown) => typeof path === 'string')) return null
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
    return { notes: value.notes, folders: value.folders }
  } catch {
    return null
  }
}

export function serializeVaultIndex(vault: Vault, library: VaultIndex): string {
  return JSON.stringify({ version: VERSION, vault: vault.uri, ...library })
}
