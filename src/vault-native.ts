import { requireOptionalNativeModule } from 'expo-modules-core'

export type VaultEntry = {
  uri: string
  isDirectory: boolean
  size?: number
}

type TypoVaultModule = {
  listChildren(uri: string): Promise<VaultEntry[]>
  readText(uri: string): Promise<string>
  readBase64(uri: string): Promise<string>
}

const nativeModule = requireOptionalNativeModule<TypoVaultModule>('TypoVault')

export function readVaultText(uri: string): Promise<string> | null {
  return nativeModule?.readText(uri) ?? null
}

export function readVaultBase64(uri: string): Promise<string> | null {
  return nativeModule?.readBase64(uri) ?? null
}

export async function listVaultEntries(uri: string): Promise<VaultEntry[] | null> {
  if (!nativeModule) return null
  return nativeModule.listChildren(uri)
}
