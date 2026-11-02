export function localBytes(
  uri: string,
  { signal, maxBytes }: { signal?: AbortSignal; maxBytes?: number } = {}
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    const abort = () => request.abort()
    const fail = (message: string) => reject(new Error(message))
    request.open('GET', uri)
    request.responseType = 'arraybuffer'
    request.timeout = 60_000
    request.onload = () => {
      if (request.status !== 0 && request.status !== 200) {
        fail('Cannot read the offline PDF resource.')
        return
      }
      const bytes = new Uint8Array(request.response ?? new ArrayBuffer(0))
      if (maxBytes && bytes.length > maxBytes) fail('This PDF exceeds the 100 MiB viewer limit.')
      else if (!bytes.length) fail('The PDF resource is empty or unavailable.')
      else resolve(bytes)
    }
    request.onprogress = (event) => {
      if (maxBytes && (event.loaded > maxBytes || event.total > maxBytes)) {
        fail('This PDF exceeds the 100 MiB viewer limit.')
        request.abort()
      }
    }
    request.onerror = () => fail('Cannot read the offline PDF resource.')
    request.ontimeout = () => fail('Reading the PDF resource timed out.')
    request.onabort = () => reject(new DOMException('PDF loading canceled.', 'AbortError'))
    request.onloadend = () => signal?.removeEventListener('abort', abort)
    if (signal?.aborted) {
      reject(new DOMException('PDF loading canceled.', 'AbortError'))
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    request.send()
  })
}
