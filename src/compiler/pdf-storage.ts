import { File } from 'expo-file-system'
import * as FileSystem from 'expo-file-system/legacy'
import { fingerprint } from './fingerprint'
import type { PdfRecord } from './workspace'

// Bump when compiler behavior, bundled fonts, or dependency tracking changes.
const CACHE_VERSION = 'typst-0.8.0-rc3-2'

export function pdfStorage(vaultUri: string) {
  if (!FileSystem.cacheDirectory) throw new Error('Private cache storage is unavailable.')
  const directory = `${FileSystem.cacheDirectory}typo-compiled/${CACHE_VERSION}/${fingerprint(vaultUri)}/`
  const manifest = (path: string) => `${directory}${fingerprint(path)}.json`
  let directoryReady: Promise<void> | null = null
  const ready = () => {
    directoryReady ??= FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(
      (cause: unknown) => {
        directoryReady = null
        throw cause
      }
    )
    return directoryReady
  }
  let pruned: Promise<void> | null = null
  const prune = () => {
    pruned ??= (async () => {
      await ready()
      const names = await FileSystem.readDirectoryAsync(directory)
      const retained = new Set<string>()
      for (const name of names.filter((name) => name.endsWith('.json'))) {
        try {
          const record = JSON.parse(await FileSystem.readAsStringAsync(`${directory}${name}`))
          if (typeof record.uri === 'string') retained.add(record.uri)
        } catch {
          // An incomplete manifest is a cache miss.
        }
      }
      await Promise.all(
        names
          .filter((name) => name.endsWith('.pdf') && !retained.has(`${directory}${name}`))
          .map((name) => FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true }))
      )
    })().catch((cause: unknown) => {
      pruned = null
      throw cause
    })
    return pruned
  }
  return {
    async read(path: string): Promise<PdfRecord | null> {
      try {
        await ready()
        const record = JSON.parse(await FileSystem.readAsStringAsync(manifest(path)))
        if (
          typeof record.sourceHash !== 'string' ||
          typeof record.fontsHash !== 'string' ||
          !record.dependencies ||
          typeof record.dependencies !== 'object' ||
          !Object.values(record.dependencies).every(
            (hash) => hash === null || typeof hash === 'string'
          ) ||
          typeof record.uri !== 'string' ||
          !record.uri.startsWith(directory) ||
          !(await FileSystem.getInfoAsync(record.uri)).exists
        )
          return null
        if (
          record.output &&
          (typeof record.output.uri !== 'string' || typeof record.output.stamp !== 'string')
        )
          return null
        return record
      } catch {
        return null
      }
    },
    async save(path: string, record: PdfRecord) {
      await ready()
      await FileSystem.writeAsStringAsync(manifest(path), JSON.stringify(record))
    },
    async cache(key: string, base64: string) {
      if (!base64.startsWith('JVBERi0')) throw new Error('The compiler did not return a PDF.')
      await prune()
      const uri = `${directory}${key}.pdf`
      await FileSystem.writeAsStringAsync(uri, base64, { encoding: 'base64' })
      return uri
    },
    base64: (uri: string) => FileSystem.readAsStringAsync(uri, { encoding: 'base64' }),
    async stamp(uri: string): Promise<string | null> {
      try {
        const file = new File(uri)
        const size = file.size
        if (!size) return null
        return `${file.modificationTime}:${size}`
      } catch {
        return null
      }
    },
  }
}
