import { GlobalWorkerOptions, getDocument, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RefProxy,
} from 'pdfjs-dist/types/src/display/api'
import {
  clampZoom,
  MAX_CACHED_PAGE_PIXELS,
  MAX_PDF_BYTES,
  pageLayout,
  retainPages,
  viewportPages,
} from './layout'
import { localBytes } from './local'
import { RenderQueue } from './render-queue'

type Theme = { background: string; foreground: string; accent: string; surface: string }
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
  text: HTMLElement | null
  links: HTMLElement | null
  textLayer: TextLayer | null
}
type SelectionBox = { left: number; top: number; right: number; bottom: number }
type Render = { order: number[]; zoom: number; width: number; key: string }
type Session = {
  uri: string
  abort: AbortController
  queue: RenderQueue<Render> | null
  task: PDFDocumentLoadingTask | null
  timeout: ReturnType<typeof setTimeout> | null
  pages: Page[]
  published: number[]
  requested: string
  latest: Render | null
  rasterizing: number | null
  rasterKey: string
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
let selectionCanvas: HTMLCanvasElement | null = null
const send = (message: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))
selectionCanvas = createSelectionCanvas()
let session: Session | null = null
let zoom = 1
let selectionContext: CanvasRenderingContext2D | null = null
let selectionBoxes: SelectionBox[] = []
let selectionScroll = { x: 0, y: 0 }
let selectionDirty = true
let selectionFrame = 0
let workerUrl: Promise<string> | null = null
// The worker script is parsed once per viewer, so opening another PDF reuses it.
let worker: Worker | null = null
let disposal = Promise.resolve()
let resizeTimer: ReturnType<typeof setTimeout>
let scrollFrame = 0
const LAYOUT_BATCH = 16

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

function release(current: Session, index: number) {
  const page = current.pages[index]
  page.textLayer?.cancel()
  page.textLayer = null
  page.text?.remove()
  page.links?.remove()
  page.text = page.links = null
  if (page.canvas) {
    page.canvas.remove()
    page.canvas.width = page.canvas.height = 1
    page.canvas = null
  }
  page.rendered = ''
  queueSelectionPaint(true)
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
  const { drop } = retainPages(current.published, first, last, (index) => {
    const page = current.pages[index]
    const pixels = page.canvas ? page.canvas.width * page.canvas.height : 0
    return page.rendered === key && pixels > 0 && pixels <= MAX_CACHED_PAGE_PIXELS
  })
  for (const index of drop) release(current, index)
  if (drop.length) current.published = current.published.filter((index) => !drop.includes(index))
  watchProgress(current)
  const render = { order, zoom, width: scroll.clientWidth, key }
  current.latest = render
  // A scroll that still needs the page being rasterized lets it finish instead of discarding it.
  const busy =
    current.rasterizing !== null && current.rasterKey === key && order.includes(current.rasterizing)
  current.queue.request(render, !busy)
}

function resizePreview() {
  if (!session?.pages.length) return
  const width = scroll.clientWidth
  const pageWidth = Math.max(1, width - 48) * zoom
  pages.style.width = `${Math.max(width, pageWidth + 48)}px`
  pages.style.setProperty('--page-width', `${pageWidth}px`)
  // Text layers scale with the page so a zoom keeps their selection intact.
  for (const page of session.pages)
    if (page.text) page.element.style.setProperty('--scale-factor', String(pageWidth / page.width))
  queueSelectionPaint(true)
}

function clearSelection() {
  selectionBoxes = []
  selectionDirty = true
  if (selectionCanvas && selectionContext)
    selectionContext.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height)
}

function selectionBands(range: Range, bounds: DOMRect) {
  const bands: SelectionBox[] = []
  const rects = range.getClientRects()
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index]
    if (rect.width <= 0 || rect.height <= 0) continue
    const left = rect.left - bounds.left
    const top = rect.top - bounds.top
    const right = rect.right - bounds.left
    const bottom = rect.bottom - bounds.top
    let merged = false
    for (let index = bands.length - 1; index >= Math.max(0, bands.length - 4); index--) {
      const band = bands[index]
      const overlap = Math.min(bottom, band.bottom) - Math.max(top, band.top)
      const minHeight = Math.min(bottom - top, band.bottom - band.top)
      const gap = Math.max(left - band.right, band.left - right)
      if (overlap >= minHeight * 0.5 && gap <= Math.max(6, minHeight * 0.8)) {
        band.left = Math.min(band.left, left)
        band.top = Math.min(band.top, top)
        band.right = Math.max(band.right, right)
        band.bottom = Math.max(band.bottom, bottom)
        merged = true
        break
      }
    }
    if (!merged) bands.push({ left, top, right, bottom })
  }
  return bands
}

function paintSelection(recompute = false) {
  const selection = window.getSelection?.()
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    clearSelection()
    return
  }
  const range = selection.getRangeAt(0)
  if (!scroll.contains(range.commonAncestorContainer)) {
    clearSelection()
    return
  }
  if (!selectionCanvas) return
  const context = selectionCanvas.getContext('2d')
  if (!context) return
  selectionContext = context
  const bounds = scroll.getBoundingClientRect()
  const width = Math.max(1, Math.round(bounds.width))
  const height = Math.max(1, Math.round(bounds.height))
  if (selectionCanvas.width !== width) selectionCanvas.width = width
  if (selectionCanvas.height !== height) selectionCanvas.height = height
  selectionCanvas.style.left = `${bounds.left}px`
  selectionCanvas.style.top = `${bounds.top}px`
  selectionCanvas.style.width = `${width}px`
  selectionCanvas.style.height = `${height}px`
  context.clearRect(0, 0, width, height)
  if (recompute || selectionDirty) {
    selectionBoxes = selectionBands(range, bounds)
    selectionScroll = { x: scroll.scrollLeft, y: scroll.scrollTop }
    selectionDirty = false
  }
  const color = getComputedStyle(document.documentElement).getPropertyValue('--selection').trim()
  if (!color) return
  const dx = scroll.scrollLeft - selectionScroll.x
  const dy = scroll.scrollTop - selectionScroll.y
  context.fillStyle = color
  context.beginPath()
  for (const box of selectionBoxes) {
    const left = box.left - dx
    const top = box.top - dy
    const right = box.right - dx
    const bottom = box.bottom - dy
    if (right <= 0 || bottom <= 0 || left >= width || top >= height) continue
    context.rect(left, top, right - left, bottom - top)
  }
  context.fill()
}

function createSelectionCanvas() {
  if (!document.body) return null
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.position = 'fixed'
  canvas.style.pointerEvents = 'none'
  canvas.style.zIndex = '2'
  document.body.append(canvas)
  return canvas
}

function queueSelectionPaint(recompute = false) {
  if (recompute) selectionDirty = true
  if (selectionFrame) return
  const selection = window.getSelection?.()
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    clearSelection()
    return
  }
  selectionFrame = requestAnimationFrame(() => {
    selectionFrame = 0
    paintSelection()
  })
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

async function goTo(current: Session, pdf: PDFDocumentProxy, destination: unknown) {
  try {
    const dest =
      typeof destination === 'string' ? await pdf.getDestination(destination) : destination
    if (!Array.isArray(dest) || !dest.length) return
    const target = dest[0]
    const index = Number.isInteger(target)
      ? (target as number)
      : await pdf.getPageIndex(target as RefProxy)
    const page = current.pages[index]
    if (session !== current || !page) return
    scroll.scrollTo(0, Math.max(0, page.element.offsetTop - 24))
    requestRender()
  } catch {
    // A broken destination should not interrupt the document.
  }
}

async function attachLayers(
  current: Session,
  target: Page,
  page: PDFPageProxy,
  pdf: PDFDocumentProxy
) {
  const text = document.createElement('div')
  text.className = 'textLayer'
  const links = document.createElement('div')
  links.className = 'linkLayer'
  target.element.append(text, links)
  target.text = text
  target.links = links
  const textLayer = new TextLayer({
    textContentSource: page.streamTextContent(),
    container: text,
    viewport: page.getViewport({ scale: 1 }),
  })
  target.textLayer = textLayer
  const annotations = page.getAnnotations().catch(() => [])
  try {
    await textLayer.render()
  } catch {
    text.remove()
    if (target.text === text) target.text = null
  } finally {
    if (target.textLayer === textLayer) target.textLayer = null
  }
  const viewport = page.getViewport({ scale: 1 })
  for (const data of await annotations) {
    if (target.links !== links) return
    if (data?.subtype !== 'Link' || !Array.isArray(data.rect)) continue
    const link = document.createElement('a')
    link.setAttribute('role', 'link')
    link.setAttribute('href', typeof data.url === 'string' ? data.url : '#')
    link.tabIndex = 0
    let activate: (() => void) | null = null
    if (typeof data.url === 'string') {
      link.setAttribute('aria-label', 'Open link. Opens in your browser')
      activate = () => send({ type: 'link', url: data.url })
    } else if (data.dest) {
      link.setAttribute('aria-label', 'Go to page')
      const dest = data.dest
      activate = () => void goTo(current, pdf, dest)
    }
    if (!activate) continue
    link.addEventListener('click', (event) => {
      event.preventDefault()
      activate()
    })
    const [x1, y1] = viewport.convertToViewportPoint(data.rect[0], data.rect[1])
    const [x2, y2] = viewport.convertToViewportPoint(data.rect[2], data.rect[3])
    link.style.left = `${(100 * Math.min(x1, x2)) / viewport.width}%`
    link.style.top = `${(100 * Math.min(y1, y2)) / viewport.height}%`
    link.style.width = `${(100 * Math.abs(x2 - x1)) / viewport.width}%`
    link.style.height = `${(100 * Math.abs(y2 - y1)) / viewport.height}%`
    links.append(link)
  }
}

async function destroy(current: Session) {
  if (current.timeout) clearTimeout(current.timeout)
  current.abort.abort()
  await current.queue?.dispose()
  // Releasing the document leaves the shared worker ready for the next file.
  await current.task?.destroy()
}

async function load(uri: string) {
  if (session?.uri === uri) return
  const old = session
  const current: Session = {
    uri,
    abort: new AbortController(),
    queue: null,
    task: null,
    timeout: null,
    pages: [],
    published: [],
    requested: '',
    latest: null,
    rasterizing: null,
    rasterKey: '',
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
    worker ??= new Worker(url)
    worker.onerror = (event) =>
      fail(current, new Error(event.message || 'The offline PDF worker could not start.'))
    worker.onmessageerror = () =>
      fail(current, new Error('The offline PDF worker sent an invalid response.'))
    GlobalWorkerOptions.workerPort = worker
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
    const pdf = await current.task.promise
    if (session !== current) return
    const fragment = document.createDocumentFragment()
    // Page sizes cross the worker boundary one page at a time, so ask in bounded batches.
    for (let start = 1; start <= pdf.numPages; start += LAYOUT_BATCH) {
      const numbers: number[] = []
      for (let number = start; number <= Math.min(start + LAYOUT_BATCH - 1, pdf.numPages); number++)
        numbers.push(number)
      const loaded = await Promise.all(numbers.map((number) => pdf.getPage(number)))
      if (session !== current) return
      for (const [offset, page] of loaded.entries()) {
        try {
          const number = numbers[offset]
          const viewport = page.getViewport({ scale: 1 })
          const node = document.createElement('section')
          node.className = 'page'
          node.style.setProperty('--page-ratio', String(viewport.height / viewport.width))
          node.style.setProperty('--user-unit', String(viewport.userUnit || 1))
          node.setAttribute('data-page', `${number} / ${pdf.numPages}`)
          node.setAttribute('aria-label', `Page ${number} of ${pdf.numPages}`)
          fragment.append(node)
          current.pages.push({
            element: node,
            width: viewport.width,
            height: viewport.height,
            canvas: null,
            rendered: '',
            text: null,
            links: null,
            textLayer: null,
          })
        } finally {
          page.cleanup()
        }
      }
    }
    // Keep the latest reading position, including scrolling while the PDF loaded.
    const position = { x: scroll.scrollLeft, y: scroll.scrollTop }
    const previous = pages.querySelectorAll('canvas')
    pages.replaceChildren(fragment)
    for (const canvas of previous) canvas.width = canvas.height = 1
    resizePreview()
    scroll.scrollTo(position.x, position.y)
    clearSelection()
    current.queue = new RenderQueue(
      async (request, signal) => {
        for (const index of request.order) {
          // A newer viewport stops the rest of this order but keeps the page in flight.
          if (signal.aborted || current.latest !== request) return
          const target = current.pages[index]
          if (target.rendered === request.key) continue
          const page = await pdf.getPage(index + 1)
          let layers: Promise<void> | null = null
          try {
            if (signal.aborted) return
            current.rasterizing = index
            current.rasterKey = request.key
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
            target.element.replaceChildren(
              buffer,
              ...(target.text ? [target.text] : []),
              ...(target.links ? [target.links] : [])
            )
            target.canvas = buffer
            target.rendered = request.key
            target.element.style.setProperty('--scale-factor', String(layout.scale))
            current.published = current.published.filter((value) => value !== index)
            current.published.push(index)
            buffer = previous ?? document.createElement('canvas')
            buffer.width = buffer.height = 1
            status.textContent = ''
            send({ type: 'rendered', uri: current.uri, page: index + 1, pages: pdf.numPages })
            if (!target.text) layers = attachLayers(current, target, page, pdf).catch(() => {})
          } finally {
            current.rasterizing = null
            if (layers) void layers.finally(() => page.cleanup())
            else page.cleanup()
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
      event.touches.length === 1 &&
      !pinch &&
      !(event.target as Element | null)?.closest?.('.linkLayer')
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
    requestRender()
    paintSelection()
  })
})
window.addEventListener('resize', () => {
  resizePreview()
  queueSelectionPaint(true)
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(requestRender, 120)
})
document.addEventListener('selectionchange', () => queueSelectionPaint(true))
document.addEventListener('touchend', () => queueSelectionPaint(true), { passive: true })
window.addEventListener('pagehide', () => {
  cancelPinch()
  const stop = session ? destroy(session) : Promise.resolve()
  void stop
    .catch(() => {})
    .then(() => {
      worker?.terminate()
      worker = null
      GlobalWorkerOptions.workerPort = null
    })
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
