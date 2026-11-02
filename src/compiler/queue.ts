type Request = { version: number; source: string }

export class CompilationQueue<T> {
  private version = 0
  private pending: Request | null = null
  private running = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private result: { version: number; value: T } | null = null
  private failure: { version: number; error: unknown } | null = null
  private waiters: { resolve(value: T): void; reject(error: unknown): void }[] = []

  constructor(
    private callbacks: {
      run(source: string, current: () => boolean): Promise<T>
      success(value: T, current: () => boolean): Promise<void>
      error(error: unknown): void
      discard(value: T): void
    }
  ) {}

  get busy() {
    return this.running || this.pending !== null
  }

  request(source: string, delay = 450) {
    if (this.disposed) return
    this.pending = { version: ++this.version, source }
    this.failure = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pump()
    }, delay)
  }

  current(): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('The note was closed.'))
    if (this.result?.version === this.version) return Promise.resolve(this.result.value)
    if (this.failure?.version === this.version) return Promise.reject(this.failure.error)
    const promise = new Promise<T>((resolve, reject) => this.waiters.push({ resolve, reject }))
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.pump()
    return promise
  }

  dispose() {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.pending = null
    this.waiters.splice(0).forEach((waiter) => {
      waiter.reject(new Error('The note was closed.'))
    })
  }

  private async pump() {
    if (this.running || this.disposed || this.timer || !this.pending) return
    const request = this.pending
    this.pending = null
    this.running = true
    const current = () => !this.disposed && this.version === request.version
    try {
      const value = await this.callbacks.run(request.source, current)
      if (!current()) this.callbacks.discard(value)
      else {
        await this.callbacks.success(value, current)
        if (current()) {
          this.result = { version: request.version, value }
          this.waiters.splice(0).forEach((waiter) => {
            waiter.resolve(value)
          })
        }
      }
    } catch (error) {
      if (current()) {
        this.failure = { version: request.version, error }
        this.callbacks.error(error)
        this.waiters.splice(0).forEach((waiter) => {
          waiter.reject(error)
        })
      }
    } finally {
      this.running = false
      if (this.pending && !this.timer) void this.pump()
    }
  }
}
