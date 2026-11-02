import * as FileSystem from 'expo-file-system/legacy'
import { type PackageSpec, packageKey } from './protocol'

let sequence = 0

async function readArchive(uri: string): Promise<string> {
  const info = await FileSystem.getInfoAsync(uri)
  if (!info.exists || info.size > 32 * 1024 * 1024)
    throw new Error('A Typst package is missing or exceeds the 32 MiB archive limit.')
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' })
  if (!base64.startsWith('H4sI'))
    throw new Error('The package server returned an invalid archive. Try generating the PDF again.')
  return base64
}

export async function packageArchive(spec: PackageSpec): Promise<string> {
  packageKey(spec)
  if (spec.namespace !== 'preview')
    throw new Error(
      `Place @${spec.namespace}/${spec.name}:${spec.version} in packages/${packageKey(spec)} inside your notes folder.`
    )
  if (!FileSystem.documentDirectory) throw new Error('Private package storage is unavailable.')
  const directory = `${FileSystem.documentDirectory}typo-packages/`
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
  const uri = `${directory}${spec.name}-${spec.version}.tar.gz`
  if ((await FileSystem.getInfoAsync(uri)).exists) {
    try {
      return await readArchive(uri)
    } catch (cause) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
      throw cause
    }
  }
  const staging = `${uri}.${Date.now()}-${++sequence}.tmp`
  try {
    const result = await FileSystem.downloadAsync(
      `https://packages.typst.org/preview/${spec.name}-${spec.version}.tar.gz`,
      staging
    )
    if (result.status !== 200) throw new Error(`Package server returned ${result.status}.`)
    const base64 = await readArchive(staging)
    if (!(await FileSystem.getInfoAsync(uri)).exists)
      await FileSystem.moveAsync({ from: staging, to: uri })
    return base64
  } catch (cause) {
    throw new Error(
      `Cannot download @preview/${spec.name}:${spec.version}. Connect to the internet for its first use. ${cause instanceof Error ? cause.message : ''}`
    )
  } finally {
    await FileSystem.deleteAsync(staging, { idempotent: true }).catch(() => {})
  }
}
