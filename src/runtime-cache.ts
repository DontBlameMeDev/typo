import type * as FileSystem from 'expo-file-system/legacy'
import { fingerprint } from './compiler/fingerprint'

export function runtimeDirectory(
  cacheDirectory: string,
  kind: string,
  html: string,
  resources: [string, string][]
): string {
  const version = fingerprint(JSON.stringify([html, resources]))
  return `${cacheDirectory}typo-runtime/${kind}-${version}/`
}

export async function pruneRuntimeCache(
  cacheDirectory: string,
  kind: string,
  current: string,
  files: Pick<typeof FileSystem, 'readDirectoryAsync' | 'getInfoAsync' | 'deleteAsync'>
): Promise<void> {
  const root = `${cacheDirectory}typo-runtime/`
  const names = await files.readDirectoryAsync(root)
  await Promise.all(
    names
      .filter((name) => name.startsWith(`${kind}-`))
      .map((name) => `${root}${name}`)
      .filter((directory) => `${directory}/` !== current)
      .map(async (directory) => {
        const info = await files.getInfoAsync(directory)
        if (info.exists && info.isDirectory)
          await files.deleteAsync(directory, { idempotent: true })
      })
  )
}
