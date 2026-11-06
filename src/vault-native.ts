import { requireOptionalNativeModule } from 'expo-modules-core'

export type VaultEntry = {
  uri: string
  isDirectory: boolean
  size?: number
  modificationTime?: number
}

type TypoVaultModule = {
  listChildren(uri: string): Promise<VaultEntry[]>
  readText(uri: string): Promise<string>
  readBase64(uri: string, maxBytes: number): Promise<string>
}

const nativeModule = requireOptionalNativeModule<TypoVaultModule>('TypoVault')

export function readVaultText(uri: string): Promise<string> | null {
  return nativeModule?.readText(uri) ?? null
}

export function readVaultBase64(uri: string, maxBytes: number): Promise<string> | null {
  return nativeModule?.readBase64(uri, maxBytes) ?? null
}

export async function listVaultEntries(uri: string): Promise<VaultEntry[] | null> {
  if (!nativeModule) return null
  return nativeModule.listChildren(uri)
}
