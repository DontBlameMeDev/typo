import type { CompileInput } from './protocol'

type Files = CompileInput['files']

export class CompilerInputs {
  loadedAt = 0
  private files: Files | null = null
  private loading: Promise<Files> | null = null

  constructor(private read: () => Promise<Files>) {}

  get(refresh = false): Promise<Files> {
    if (!refresh && this.files) return Promise.resolve(this.files)
    if (this.loading) return this.loading
    this.loading = this.read()
      .then((files) => {
        this.files = files
        this.loadedAt = Date.now()
        return files
      })
      .catch((cause: unknown) => {
        this.files = null
        this.loadedAt = 0
        throw cause
      })
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }
}
