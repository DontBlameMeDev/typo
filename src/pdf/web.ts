import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import { clampZoom, MAX_PDF_BYTES, pageLayout, scrollbarThumb, viewportPages } from './layout'
import { localBytes } from './local'
import { RenderQueue } from './render-queue'

type Theme = { background: string; foreground: string; accent: string; scrollbar: string }
declare global {
  interface Window {
    typoPdf: { load: (uri: string) => void; theme: (theme: Theme) => void }
  }
}
type Page = {
  element: HTMLElement
  width: number
  height: number
  canvas: HTMLCanvasElement | null
  rendered: string
}
type Render = { order: number[]; zoom: number; width: number; key: string }
type Session = {
  uri: string
  abort: AbortController
  queue: RenderQueue<Render> | null
  task: PDFDocumentLoadingTask | null
  worker: Worker | null
  document: PDFDocumentProxy | null
  timeout: ReturnType<typeof setTimeout> | null
  pages: Page[]
  published: Set<number>
  requested: string
}
type Point = { x: number; y: number }
type Anchor = { page: Page; x: number; y: number }

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing PDF element: ${id}`)
  return found as T
}
let buffer = document.createElement('canvas')
const scroll = element<HTMLElement>('scroll')
const pages = element<HTMLElement>('pages')
const status = element<HTMLElement>('status')
const bar = element<HTMLElement>('scrollbar')
const thumb = element<HTMLElement>('thumb')
const send = (message: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))
let session: Session | null = null
let zoom = 1
let workerUrl: Promise<string> | null = null
let disposal = Promise.resolve()
let resizeTimer: ReturnType<typeof setTimeout>
let scrollFrame = 0

function fail(current: Session, cause: unknown) {
  if (session !== current || current.abort.signal.aborted) return
  status.textContent = cause instanceof Error ? cause.message : 'Cannot display this PDF.'
  send({ type: 'error', message: status.textContent })
}

function watchProgress(current: Session) {
  if (current.timeout) clearTimeout(current.timeout)
  current.timeout = setTimeout(
    () => fail(current, new Error('Displaying this PDF took too long. Try a smaller document.')),
    60_000
  )
}

function pageAt(y: number) {
  const list = session?.pages ?? []
  let low = 0
  let high = list.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const node = list[mid].element
    if (node.offsetTop + node.offsetHeight < y) low = mid + 1
    else high = mid
  }
  return low
}

function requestRender() {
  const current = session
  if (!current?.queue || !current.pages.length || pinch) return
  const firstVisible = pageAt(scroll.scrollTop)
  const lastVisible = pageAt(scroll.scrollTop + scroll.clientHeight)
  const { first, last, order } = viewportPages(firstVisible, lastVisible, current.pages.length)
  const key = `${zoom}:${scroll.clientWidth}`
  const requested = `${firstVisible}:${lastVisible}:${key}`
  if (current.requested === requested) return
  current.requested = requested
  for (const index of current.published) {
    if (index >= first && index <= last) continue
    const page = current.pages[index]
    if (page.canvas) {
      page.canvas.remove()
      page.canvas.width = page.canvas.height = 1
      page.canvas = null
      page.rendered = ''
    }
    current.published.delete(index)
  }
  watchProgress(current)
  current.queue.request({ order, zoom, width: scroll.clientWidth, key })
}

function resizePreview() {
  if (!session?.pages.length) return
  const width = scroll.clientWidth
  const pageWidth = Math.max(1, width - 24) * zoom
  pages.style.width = `${Math.max(width, pageWidth + 24)}px`
  pages.style.setProperty('--page-width', `${pageWidth}px`)
}

function updateScrollbar() {
  const metrics = scrollbarThumb(scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight)
  bar.hidden = !metrics
  if (!metrics) return
  thumb.style.height = `${metrics.length}px`
  thumb.style.transform = `translateY(${metrics.offset}px)`
}

function anchorAt(point: Point): Anchor | null {
  const page = session?.pages[pageAt(scroll.scrollTop + point.y)]
  if (!page) return null
  return {
    page,
    x: (scroll.scrollLeft + point.x - page.element.offsetLeft) / page.element.offsetWidth,
    y: (scroll.scrollTop + point.y - page.element.offsetTop) / page.element.offsetHeight,
  }
}

function setZoom(value: number, point: Point, anchor = anchorAt(point)) {
  const next = clampZoom(value)
  if (zoom !== next) {
    zoom = next
    resizePreview()
  }
  if (anchor) {
    const node = anchor.page.element
    scroll.scrollLeft = node.offsetLeft + anchor.x * node.offsetWidth - point.x
    scroll.scrollTop = node.offsetTop + anchor.y * node.offsetHeight - point.y
  }
}

async function destroy(current: Session) {
  if (current.timeout) clearTimeout(current.timeout)
  current.abort.abort()
  await current.queue?.dispose()
  try {
    await current.task?.destroy()
  } finally {
    current.worker?.terminate()
    if (GlobalWorkerOptions.workerPort === current.worker) GlobalWorkerOptions.workerPort = null
  }
}

async function load(uri: string) {
  if (session?.uri === uri) return
  const old = session
  const current: Session = {
    uri,
    abort: new AbortController(),
    queue: null,
    task: null,
    worker: null,
    document: null,
    timeout: null,
    pages: [],
    published: new Set(),
    requested: '',
  }
  cancelPinch()
  session = current
  watchProgress(current)
  old?.abort.abort()
  status.textContent = ''
  // Release the previous document, including fonts and worker caches, before reading another.
  disposal = disposal.catch(() => {}).then(() => (old ? destroy(old) : undefined))
  try {
    await disposal
    if (session !== current) return
    if (!uri.startsWith('file://')) throw new Error('The PDF viewer requires a local file.')
    workerUrl ??= localBytes('pdf-worker.bundle.js').then((bytes) =>
      URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'text/javascript' }))
    )
    const url = await workerUrl
    if (session !== current) return
    const bytes = await localBytes(uri, { signal: current.abort.signal, maxBytes: MAX_PDF_BYTES })
    if (session !== current) return
    current.worker = new Worker(url)
    current.worker.onerror = (event) =>
      fail(current, new Error(event.message || 'The offline PDF worker could not start.'))
    current.worker.onmessageerror = () =>
      fail(current, new Error('The offline PDF worker sent an invalid response.'))
    GlobalWorkerOptions.workerPort = current.worker
    current.task = getDocument({
      data: bytes,
      useSystemFonts: false,
      // Cap decoded images and canvas allocations. Document data and fonts still scale with input.
      maxImageSize: 16_000_000,
      canvasMaxAreaInBytes: 16_000_000,
      isImageDecoderSupported: false,
      disableWorkerRendering: true,
    })
    current.task.onPassword = () =>
      fail(current, new Error('Password-protected PDFs are not supported.'))
    current.document = await current.task.promise
    if (session !== current) return
    const pdf = current.document
    const fragment = document.createDocumentFragment()
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      if (session !== current) return
      const viewport = page.getViewport({ scale: 1 })
      const node = document.createElement('section')
      node.className = 'page'
      node.style.setProperty('--page-ratio', String(viewport.height / viewport.width))
      node.setAttribute('aria-label', `Page ${number} of ${pdf.numPages}`)
      fragment.append(node)
      current.pages.push({
        element: node,
        width: viewport.width,
        height: viewport.height,
        canvas: null,
        rendered: '',
      })
      page.cleanup()
    }
    // Keep the latest reading position, including scrolling while the PDF loaded.
    const position = { x: scroll.scrollLeft, y: scroll.scrollTop }
    const previous = pages.querySelectorAll('canvas')
    pages.replaceChildren(fragment)
    for (const canvas of previous) canvas.width = canvas.height = 1
    resizePreview()
    scroll.scrollTo(position.x, position.y)
    updateScrollbar()
    current.queue = new RenderQueue(
      async (request, signal) => {
        for (const index of request.order) {
          const target = current.pages[index]
          if (target.rendered === request.key) continue
          const page = await pdf.getPage(index + 1)
          try {
            if (signal.aborted) return
            const layout = pageLayout(
              target.width,
              target.height,
              request.width,
              request.zoom,
              window.devicePixelRatio
            )
            buffer.width = layout.width
            buffer.height = layout.height
            const task = page.render({
              canvas: buffer,
              viewport: page.getViewport({ scale: layout.scale }),
              transform: [layout.ratio, 0, 0, layout.ratio, 0, 0],
              background: '#ffffff',
            })
            const cancel = () => task.cancel()
            signal.addEventListener('abort', cancel, { once: true })
            try {
              await task.promise
            } finally {
              signal.removeEventListener('abort', cancel)
            }
            if (signal.aborted || session !== current) return
            const previous = target.canvas
            target.element.replaceChildren(buffer)
            target.canvas = buffer
            target.rendered = request.key
            current.published.add(index)
            buffer = previous ?? document.createElement('canvas')
            buffer.width = buffer.height = 1
            status.textContent = ''
            send({ type: 'rendered', uri: current.uri, page: index + 1, pages: pdf.numPages })
          } finally {
            page.cleanup()
          }
        }
        if (current.timeout) clearTimeout(current.timeout)
      },
      (cause) => fail(current, cause)
    )
    requestRender()
  } catch (cause) {
    fail(current, cause)
  }
}

let pinch: {
  distance: number
  zoom: number
  anchor: Anchor | null
  pending: { zoom: number; point: Point } | null
} | null = null
let pinchFrame = 0

function flushPinch() {
  cancelAnimationFrame(pinchFrame)
  pinchFrame = 0
  if (!pinch?.pending) return
  const { zoom, point } = pinch.pending
  pinch.pending = null
  setZoom(zoom, point, pinch.anchor)
}

function cancelPinch() {
  cancelAnimationFrame(pinchFrame)
  pinchFrame = 0
  pinch = null
}
let tap: { point: Point; time: number } | null = null
let lastTap: { point: Point; time: number } | null = null
const distance = (touches: TouchList) =>
  Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
function localPoint(x: number, y: number): Point {
  const rect = scroll.getBoundingClientRect()
  return { x: x - rect.left, y: y - rect.top }
}
function midpoint(touches: TouchList) {
  return localPoint(
    (touches[0].clientX + touches[1].clientX) / 2,
    (touches[0].clientY + touches[1].clientY) / 2
  )
}
scroll.addEventListener('touchstart', (event) => {
  if (event.touches.length === 2) {
    tap = lastTap = null
    flushPinch()
    pinch = {
      distance: distance(event.touches),
      zoom,
      anchor: anchorAt(midpoint(event.touches)),
      pending: null,
    }
  } else {
    tap =
      event.touches.length === 1 && !pinch
        ? {
            point: localPoint(event.touches[0].clientX, event.touches[0].clientY),
            time: Date.now(),
          }
        : null
  }
})
scroll.addEventListener(
  'touchmove',
  (event) => {
    if (tap) {
      const point = localPoint(event.touches[0].clientX, event.touches[0].clientY)
      if (Math.hypot(point.x - tap.point.x, point.y - tap.point.y) > 10) tap = lastTap = null
    }
    if (!pinch || event.touches.length !== 2) return
    event.preventDefault()
    if (pinch.distance > 0) {
      pinch.pending = {
        zoom: (pinch.zoom * distance(event.touches)) / pinch.distance,
        point: midpoint(event.touches),
      }
      if (!pinchFrame) pinchFrame = requestAnimationFrame(flushPinch)
    }
  },
  { passive: false }
)
scroll.addEventListener(
  'touchend',
  (event) => {
    if (pinch) {
      if (event.touches.length < 2) {
        flushPinch()
        pinch = null
        requestRender()
      }
      return
    }
    if (!tap || event.touches.length) return
    const now = Date.now()
    if (now - tap.time < 250) {
      if (
        lastTap &&
        now - lastTap.time < 300 &&
        Math.hypot(tap.point.x - lastTap.point.x, tap.point.y - lastTap.point.y) < 30
      ) {
        event.preventDefault()
        setZoom(1, tap.point)
        requestRender()
        lastTap = null
      } else lastTap = { point: tap.point, time: now }
    } else lastTap = null
    tap = null
  },
  { passive: false }
)
scroll.addEventListener('touchcancel', () => {
  flushPinch()
  pinch = null
  tap = lastTap = null
  requestRender()
})
scroll.addEventListener('dblclick', (event) => {
  setZoom(1, localPoint(event.clientX, event.clientY))
  requestRender()
})
scroll.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    setZoom(zoom * Math.exp(-event.deltaY * 0.01), localPoint(event.clientX, event.clientY))
    requestRender()
  },
  { passive: false }
)
scroll.addEventListener('scroll', () => {
  if (scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    updateScrollbar()
    requestRender()
  })
})
if (window.ResizeObserver) {
  const resized = new window.ResizeObserver(updateScrollbar)
  resized.observe(scroll)
  resized.observe(pages)
}
window.addEventListener('resize', () => {
  resizePreview()
  updateScrollbar()
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(requestRender, 120)
})
window.addEventListener('pagehide', () => {
  cancelPinch()
  if (session) void destroy(session)
  void workerUrl?.then((url) => URL.revokeObjectURL(url))
})
window.typoPdf = {
  load: (uri: string) => void load(uri),
  theme: (theme: Theme) => {
    for (const [key, value] of Object.entries(theme))
      document.documentElement.style.setProperty(`--${key}`, value)
  },
}
send({ type: 'boot' })
