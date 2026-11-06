import { describe, expect, test } from 'bun:test'
import { pdfHtml } from '../src/pdf/document'
import {
  clampPage,
  clampZoom,
  MAX_CANVAS_PIXELS,
  MAX_CANVAS_SIDE,
  pageLayout,
} from '../src/pdf/layout'
import { RenderQueue } from '../src/pdf/render-queue'

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('PDF layout', () => {
  test('fits page width with a margin and uses the screen pixel ratio', () => {
    const layout = pageLayout(600, 800, 384, 1, 2)
    expect(layout.cssWidth).toBe(360)
    expect(layout.cssHeight).toBe(480)
    expect(layout.width).toBe(720)
    expect(layout.height).toBe(960)
  })

  test('caps canvas pixels and each side at high zoom on large screens', () => {
    for (const [width, height] of [
      [600, 800],
      [200, 10000],
      [10000, 200],
    ]) {
      for (const zoom of [0.5, 1, 4]) {
        const layout = pageLayout(width, height, 2500, zoom, 4)
        expect(layout.width * layout.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS)
        expect(layout.width).toBeLessThanOrEqual(MAX_CANVAS_SIDE)
        expect(layout.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE)
        expect(layout.width).toBeGreaterThan(0)
        expect(layout.height).toBeGreaterThan(0)
      }
    }
  })

  test('rejects invalid page dimensions and clamps page and zoom input', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => pageLayout(value, 800, 384, 1, 1)).toThrow('invalid dimensions')
    expect(() => pageLayout(1, 1e308, 384, 4, 1)).toThrow('invalid dimensions')
    expect(clampPage(-5, 50)).toBe(1)
    expect(clampPage(500, 50)).toBe(50)
    expect(clampPage(2.6, 50)).toBe(3)
    expect(clampPage(Number.NaN, 50)).toBe(1)
    expect(clampZoom(0.1)).toBe(0.5)
    expect(clampZoom(10)).toBe(4)
    expect(clampZoom(Number.NaN)).toBe(1)
  })
})

describe('PDF render queue', () => {
  test('coalesces rapid input and cancels before reusing the canvas', async () => {
    const release = deferred()
    const started = deferred()
    const rendered = deferred()
    const seen: number[] = []
    let active: AbortSignal | undefined
    const errors: unknown[] = []
    const queue = new RenderQueue<number>(
      async (value, signal) => {
        seen.push(value)
        if (value === 1) {
          active = signal
          started.resolve()
          await release.promise
        } else rendered.resolve()
      },
      (cause) => errors.push(cause)
    )
    queue.request(1)
    await started.promise
    queue.request(2)
    queue.request(3)
    expect(active?.aborted).toBe(true)
    await tick()
    expect(seen).toEqual([1])
    release.resolve()
    await rendered.promise
    await queue.dispose()
    expect(seen).toEqual([1, 3])
    expect(errors).toEqual([])
  })

  test('synchronous requests render only the latest page', async () => {
    const rendered = deferred()
    const seen: number[] = []
    const queue = new RenderQueue<number>(
      async (value) => {
        seen.push(value)
        rendered.resolve()
      },
      () => {}
    )
    queue.request(1)
    queue.request(20)
    queue.request(100)
    await rendered.promise
    await queue.dispose()
    expect(seen).toEqual([100])
  })

  test('reports real errors and ignores canceled render failures', async () => {
    const started = deferred()
    const release = deferred()
    const failed = deferred()
    const errors: unknown[] = []
    const queue = new RenderQueue<number>(
      async (value) => {
        if (value === 1) {
          started.resolve()
          await release.promise
        }
        throw new Error(`page ${value}`)
      },
      (cause) => {
        errors.push(cause)
        failed.resolve()
      }
    )
    queue.request(1)
    await started.promise
    queue.request(2)
    release.resolve()
    await failed.promise
    await queue.dispose()
    expect(errors.map(String)).toEqual(['Error: page 2'])
  })

  test('disposal waits for cleanup and never starts a pending or future page', async () => {
    const started = deferred()
    const release = deferred()
    const seen: number[] = []
    const queue = new RenderQueue<number>(
      async (value) => {
        seen.push(value)
        started.resolve()
        await release.promise
      },
      () => {}
    )
    queue.request(1)
    await started.promise
    queue.request(2)
    let disposed = false
    const disposing = queue.dispose().then(() => {
      disposed = true
    })
    await tick()
    expect(disposed).toBe(false)
    release.resolve()
    await disposing
    queue.request(3)
    await tick()
    expect(seen).toEqual([1])
  })
})

test('offline PDF shell has continuous pages, no toolbar or remote scripts, and a restricted CSP', () => {
  const html = pdfHtml()
  for (const id of ['scroll', 'pages', 'status']) expect(html).toContain(`id="${id}"`)
  expect(html).not.toContain('<button')
  expect(html).not.toContain('<nav')
  expect(html).toContain('gap:12px')
  expect(html).toContain('height:calc(var(--page-width) * var(--page-ratio))')
  expect(html).not.toContain('aspect-ratio')
  expect(html).toContain('touch-action:pan-x pan-y')
  expect(html).toContain('overflow-anchor:none')
  expect(html).toContain('scrollbar-width:none')
  expect(html).toContain('#scroll::-webkit-scrollbar{display:none}')
  expect(html).not.toContain('scrollbar-gutter')
  expect(html).toContain('aria-label="PDF pages" tabindex="0"')
  expect(html).toContain('src="pdf.bundle.js"')
  expect(html).toContain("default-src 'none'")
  expect(html).toContain("connect-src 'self' file:")
  expect(html).not.toContain('https://')
  expect(html).not.toContain("'unsafe-eval'")
  expect(html).not.toContain('Loading')
  expect(html).not.toContain('Rendering')
  expect(html).toContain('aria-live="polite"></div>')
})
