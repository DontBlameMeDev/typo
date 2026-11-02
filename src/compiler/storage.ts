import * as FileSystem from 'expo-file-system/legacy'

let sequence = 0

export async function cacheCompiledPdf(base64: string): Promise<string> {
  if (!base64.startsWith('JVBERi0')) throw new Error('The compiler did not return a PDF.')
  if (!FileSystem.cacheDirectory) throw new Error('Private cache storage is unavailable.')
  const directory = `${FileSystem.cacheDirectory}typo-pdfs/`
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
  let uri: string
  do {
    uri = `${directory}note-${Date.now().toString(36)}-${(++sequence).toString(36)}.pdf`
  } while ((await FileSystem.getInfoAsync(uri)).exists)
  try {
    await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 })
    return uri
  } catch (cause) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
    throw cause
  }
}
