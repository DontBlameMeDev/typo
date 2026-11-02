import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import { clampPage, clampZoom, MAX_PDF_BYTES, MAX_ZOOM, MIN_ZOOM, pageLayout } from './layout'
import { localBytes } from './local'
import { RenderQueue } from './render-queue'

type Theme = { background: string; foreground: string; accent: string }
declare global {
  interface Window {
    typoPdf: { load: (uri: string) => void; theme: (theme: Theme) => void }
  }
}
type Session = {
  uri: string
  abort: AbortController
  queue: RenderQueue<number> | null
  task: PDFDocumentLoadingTask | null
  worker: Worker | null
  document: PDFDocumentProxy | null
  timeout: ReturnType<typeof setTimeout> | null
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing PDF control: ${id}`)
  return found as T
}
let canvas = element<HTMLCanvasElement>('canvas')
let buffer = document.createElement('canvas')
const scroll = element<HTMLElement>('scroll')
const status = element<HTMLElement>('status')
const pageInput = element<HTMLInputElement>('page')
const count = element<HTMLElement>('count')
const previous = element<HTMLButtonElement>('previous')
const next = element<HTMLButtonElement>('next')
const zoomIn = element<HTMLButtonElement>('in')
const zoomOut = element<HTMLButtonElement>('out')
const fit = element<HTMLButtonElement>('fit')
const send = (message: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))
let session: Session | null = null
let pageNumber = 1
let pageCount = 0
let zoom = 1
let workerUrl: Promise<string> | null = null
let disposal = Promise.resolve()
let resizeTimer: ReturnType<typeof setTimeout>
let pageSize: { width: number; height: number } | null = null

class LocalBinaryDataFactory {
  constructor(private urls: Record<string, string>) {}
  fetch({ kind, filename }: { kind: string; filename: string }) {
    const base = this.urls[kind]
    if (!base || !/^[\w.-]+$/.test(filename)) throw new Error('Invalid offline PDF resource.')
    return localBytes(`${base}${filename}`)
  }
}

function controls() {
  const pages = session?.document?.numPages ?? pageCount
  pageInput.value = pages ? String(pageNumber) : ''
  pageInput.max = String(pages)
  pageInput.disabled = !pages
  count.textContent = pages ? `/ ${pages}` : ''
  previous.disabled = !pages || pageNumber <= 1
  next.disabled = !pages || pageNumber >= pages
  zoomOut.disabled = !pages || zoom <= MIN_ZOOM
  zoomIn.disabled = !pages || zoom >= MAX_ZOOM
  fit.disabled = !pages
  fit.textContent = zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`
}

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

function requestRender() {
  if (!session?.document) return
  watchProgress(session)
  controls()
  session.queue?.request(pageNumber)
}

function goTo(page: number) {
  if (!pageCount) return
  pageNumber = clampPage(page, pageCount)
  scroll.scrollTo(0, 0)
  requestRender()
}

function resizePreview() {
  if (!pageSize) return
  const layout = pageLayout(pageSize.width, pageSize.height, scroll.clientWidth, zoom, 1)
  canvas.style.width = `${layout.cssWidth}px`
  canvas.style.height = `${layout.cssHeight}px`
}

function setZoom(value: number, render = true) {
  zoom = clampZoom(value)
  controls()
  resizePreview()
  if (render) requestRender()
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
  }
  session = current
  watchProgress(current)
  old?.abort.abort()
  status.textContent = ''
  controls()
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
    const base = new URL('pdf/', window.location.href).href
    current.task = getDocument({
      data: bytes,
      cMapUrl: `${base}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${base}standard_fonts/`,
      wasmUrl: `${base}wasm/`,
      iccUrl: `${base}iccs/`,
      BinaryDataFactory: LocalBinaryDataFactory,
      useWorkerFetch: false,
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
    pageCount = pdf.numPages
    pageNumber = clampPage(pageNumber, pageCount)
    current.queue = new RenderQueue(
      async (number, signal) => {
        const page = await pdf.getPage(number)
        try {
          if (signal.aborted) return
          const renderZoom = zoom
          const viewport = page.getViewport({ scale: 1 })
          const layout = pageLayout(
            viewport.width,
            viewport.height,
            scroll.clientWidth,
            renderZoom,
            window.devicePixelRatio
          )
          buffer.width = layout.width
          buffer.height = layout.height
          buffer.style.width = `${layout.cssWidth}px`
          buffer.style.height = `${layout.cssHeight}px`
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
          buffer.id = 'canvas'
          buffer.hidden = false
          const previous = canvas
          previous.replaceWith(buffer)
          canvas = buffer
          buffer = previous
          buffer.removeAttribute('id')
          buffer.width = buffer.height = 1
          pageSize = { width: viewport.width, height: viewport.height }
          status.textContent = ''
          if (current.timeout) clearTimeout(current.timeout)
          send({ type: 'rendered', page: number, pages: pdf.numPages })
        } finally {
          page.cleanup()
        }
      },
      (cause) => fail(current, cause)
    )
    requestRender()
  } catch (cause) {
    fail(current, cause)
  }
}

previous.onclick = () => goTo(pageNumber - 1)
next.onclick = () => goTo(pageNumber + 1)
pageInput.onchange = () => goTo(Number(pageInput.value))
pageInput.onkeydown = (event) => {
  if (event.key === 'Enter') {
    goTo(Number(pageInput.value))
    pageInput.blur()
  }
}
zoomIn.onclick = () => setZoom(zoom * 1.25)
zoomOut.onclick = () => setZoom(zoom / 1.25)
fit.onclick = () => {
  setZoom(1)
  scroll.scrollTo(0, 0)
}
let pinch: { distance: number; zoom: number } | null = null
const distance = (touches: TouchList) =>
  Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
scroll.addEventListener('touchstart', (event) => {
  if (event.touches.length === 2) pinch = { distance: distance(event.touches), zoom }
})
scroll.addEventListener(
  'touchmove',
  (event) => {
    if (!pinch || event.touches.length !== 2) return
    event.preventDefault()
    if (pinch.distance > 0) setZoom((pinch.zoom * distance(event.touches)) / pinch.distance, false)
  },
  { passive: false }
)
const endPinch = () => {
  if (!pinch) return
  pinch = null
  requestRender()
}
scroll.addEventListener('touchend', endPinch)
scroll.addEventListener('touchcancel', endPinch)
window.addEventListener('resize', () => {
  resizePreview()
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(requestRender, 120)
})
window.addEventListener('pagehide', () => {
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
