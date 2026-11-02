class Fingerprint {
  private first = 0x811c9dc5
  private second = 0x9e3779b9
  private length = 0

  add(value: string, start: number, end: number) {
    this.length += end - start
    for (let index = start; index < end; index++) {
      const code = value.charCodeAt(index)
      this.first = Math.imul(this.first ^ code, 0x01000193)
      this.second = Math.imul(this.second ^ code, 0x5bd1e995)
      this.second ^= this.second >>> 13
    }
  }

  value() {
    return `${this.length.toString(36)}-${(this.first >>> 0).toString(36)}-${(this.second >>> 0).toString(36)}`
  }
}

// Non-cryptographic content keys. Chunk large inputs to keep the UI responsive.
export function fingerprint(value: string): string {
  const hash = new Fingerprint()
  hash.add(value, 0, value.length)
  return hash.value()
}

export async function fingerprintAsync(value: string): Promise<string> {
  const hash = new Fingerprint()
  for (let start = 0; start < value.length; start += 65536) {
    hash.add(value, start, Math.min(start + 65536, value.length))
    if (start + 65536 < value.length) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return hash.value()
}
