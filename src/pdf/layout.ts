export const MAX_CANVAS_PIXELS = 4_000_000
export const MAX_CANVAS_SIDE = 4096
export const MAX_PDF_BYTES = 100 * 1024 * 1024
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 4

export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(1, Math.round(Number.isFinite(page) ? page : 1)), count)
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(zoom) ? zoom : 1))
}

export function viewportPages(firstVisible: number, lastVisible: number, count: number) {
  const first = Math.max(0, firstVisible - 1)
  const last = Math.min(count - 1, lastVisible + 1)
  const order: number[] = []
  for (let index = firstVisible; index <= lastVisible; index++) order.push(index)
  if (first < firstVisible) order.push(first)
  if (last > lastVisible) order.push(last)
  return { first, last, order }
}

export function pageLayout(
  width: number,
  height: number,
  availableWidth: number,
  zoom: number,
  pixelRatio: number
) {
  if (![width, height, availableWidth].every((value) => Number.isFinite(value) && value > 0))
    throw new Error('The PDF page has invalid dimensions.')
  const scale = (Math.max(1, availableWidth - 24) / width) * clampZoom(zoom)
  const cssWidth = width * scale
  const cssHeight = height * scale
  if (!Number.isFinite(cssWidth * cssHeight))
    throw new Error('The PDF page has invalid dimensions.')
  const ratio = Math.min(
    Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1),
    Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)),
    MAX_CANVAS_SIDE / cssWidth,
    MAX_CANVAS_SIDE / cssHeight
  )
  return {
    scale,
    cssWidth,
    cssHeight,
    width: Math.max(1, Math.floor(cssWidth * ratio)),
    height: Math.max(1, Math.floor(cssHeight * ratio)),
    ratio,
  }
}
