import type { Note, Vault } from './types'

// The launch cache stores the whole library, sources included, so search works
// before the first scan finishes. Keep the format pure and free of native
// imports so benchmarks can measure the launch path.
const VERSION = 2

export function parseVaultIndex(text: string, vault: Vault): Note[] | null {
  try {
    const value = JSON.parse(text)
    if (value.version !== VERSION || value.vault !== vault.uri || !Array.isArray(value.notes))
      return null
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

export function serializeVaultIndex(vault: Vault, notes: Note[]): string {
  return JSON.stringify({ version: VERSION, vault: vault.uri, notes })
}
