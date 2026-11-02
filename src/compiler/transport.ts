import type { CompileInput, CompileRequest } from './protocol'

export class CompilerTransport {
  private files: CompileInput['files'] | null = null
  private contents = new Map<string, string>()
  private archives = new Map<string, string>()

  request(input: CompileInput, id: number, archives: Map<string, string>): CompileRequest {
    const request: CompileRequest = {
      id,
      path: input.path,
      source: input.source,
      archives: [...archives]
        .filter(([key, base64]) => this.archives.get(key) !== base64)
        .map(([key, base64]) => ({ key, base64 })),
    }
    if (this.files !== input.files) {
      request.resetFiles = this.files === null
      request.files = input.files.filter((file) => this.contents.get(file.path) !== file.base64)
      const paths = new Set(input.files.map((file) => file.path))
      request.removed = [...this.contents.keys()].filter((path) => !paths.has(path))
      this.contents = new Map(input.files.map((file) => [file.path, file.base64]))
    }
    this.files = input.files
    for (const [key, base64] of archives) this.archives.set(key, base64)
    return request
  }

  reset() {
    this.files = null
    this.contents.clear()
    this.archives.clear()
  }
}
