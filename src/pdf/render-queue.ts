// A canvas cannot be reused until its canceled PDF.js render has settled.
export class RenderQueue<T> {
  private next: { value: T } | null = null
  private active: AbortController | null = null
  private running: Promise<void> | null = null
  private stopped = false

  constructor(
    private render: (value: T, signal: AbortSignal) => Promise<void>,
    private onError: (cause: unknown) => void
  ) {}

  request(value: T, interrupt = true): void {
    if (this.stopped) return
    this.next = { value }
    if (interrupt) this.active?.abort()
    this.running ??= this.drain()
  }

  async dispose(): Promise<void> {
    this.stopped = true
    this.next = null
    this.active?.abort()
    await this.running
  }

  private async drain(): Promise<void> {
    // Start in a microtask so synchronous requests share one render.
    await Promise.resolve()
    try {
      while (this.next && !this.stopped) {
        const { value } = this.next
        this.next = null
        const controller = new AbortController()
        this.active = controller
        try {
          await this.render(value, controller.signal)
        } catch (cause) {
          if (!controller.signal.aborted) this.onError(cause)
        }
      }
    } finally {
      this.active = null
      this.running = null
    }
  }
}
