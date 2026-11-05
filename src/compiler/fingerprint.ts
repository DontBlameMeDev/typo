class Fingerprint {
  private first = 0x811c9dc5
  private second = 0x9e3779b9
  private length = 0

  add(value: string, start: number, end: number) {
    this.length += end - start
    let first = this.first
    let second = this.second
    let index = start
    for (; index + 4 <= end; index += 4) {
      first = Math.imul(first ^ value.charCodeAt(index), 0x01000193)
      second = Math.imul(second ^ value.charCodeAt(index), 0x5bd1e995)
      first = Math.imul(first ^ value.charCodeAt(index + 1), 0x01000193)
      second = Math.imul(second ^ value.charCodeAt(index + 1), 0x5bd1e995)
      first = Math.imul(first ^ value.charCodeAt(index + 2), 0x01000193)
      second = Math.imul(second ^ value.charCodeAt(index + 2), 0x5bd1e995)
      first = Math.imul(first ^ value.charCodeAt(index + 3), 0x01000193)
      second = Math.imul(second ^ value.charCodeAt(index + 3), 0x5bd1e995)
      second ^= second >>> 13
    }
    for (; index < end; index++) {
      const code = value.charCodeAt(index)
      first = Math.imul(first ^ code, 0x01000193)
      second = Math.imul(second ^ code, 0x5bd1e995)
      second ^= second >>> 13
    }
    this.first = first
    this.second = second
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
  let start = 0
  let lastYield = performance.now()
  while (start < value.length) {
    const end = Math.min(start + 65536, value.length)
    hash.add(value, start, end)
    start = end
    if (start < value.length && performance.now() - lastYield >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      lastYield = performance.now()
    }
  }
  return hash.value()
}
