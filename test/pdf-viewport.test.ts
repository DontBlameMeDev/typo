import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { pageLayout, viewportPages } from '../src/pdf/layout'

const build = await Bun.build({
  entrypoints: [`${import.meta.dir}/../src/pdf/web.ts`],
  target: 'browser',
  plugins: [
    {
      name: 'pdf-viewport-test',
      setup(builder) {
        builder.onResolve({ filter: /^(pdfjs-dist\/|\.\/local$)/ }, (args) => ({
          path: args.path,
          namespace: 'viewport-test',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'viewport-test' }, (args) => ({
          contents:
            args.path === './local'
              ? 'export const localBytes=async()=>new Uint8Array([1])'
              : 'export const GlobalWorkerOptions={}; export const getDocument=()=>globalThis.pdfTask; export class TextLayer{constructor({container}){this.container=container;this.textDivs=[]} render(){const span=document.createElement("span");span.textContent="selectable";this.container.append(span);this.textDivs.push(span);return Promise.resolve()} cancel(){}}',
          loader: 'js',
        }))
      },
    },
  ],
})
if (!build.success) throw new AggregateError(build.logs, 'Cannot build the PDF viewport test.')
const code = await build.outputs[0].text()

type TouchEvent = { touches: { clientX: number; clientY: number }[]; preventDefault(): void }

class Node {
  children: Node[] = []
  parent: Node | null = null
  properties = new Map<string, string>()
  attributes = new Map<string, string>()
  listeners = new Map<string, (event: TouchEvent) => void>()
  style = {
    width: '',
    height: '',
    left: '',
    top: '',
    setProperty: (key: string, value: string) => this.properties.set(key, value),
  }
  width = 0
  height = 0
  scrollTop = 0
  scrollLeft = 0
  clientWidth = 384
  clientHeight = 480
  textContent = ''

  constructor(readonly tag: string) {}

  className = ''

  get offsetWidth(): number {
    return Number.parseFloat(this.parent?.properties.get('--page-width') ?? '336')
  }
  get offsetHeight(): number {
    return this.offsetWidth * Number(this.properties.get('--page-ratio') ?? 1)
  }
  get offsetTop(): number {
    const siblings = this.parent?.children ?? []
    return siblings
      .slice(0, siblings.indexOf(this))
      .reduce((top, node) => top + node.offsetHeight + 16, 24)
  }
  get offsetLeft() {
    return 24
  }
  getBoundingClientRect() {
    return { left: 0, top: 0 }
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  addEventListener(type: string, callback: (event: TouchEvent) => void) {
    this.listeners.set(type, callback)
  }
  dispatch(type: string, touches: { clientX: number; clientY: number }[] = []) {
    this.listeners.get(type)?.({ touches, preventDefault() {} })
  }
  append(...children: Node[]) {
    for (const child of children) {
      child.remove()
      child.parent = this
      this.children.push(child)
    }
  }
  replaceChildren(...children: Node[]) {
    for (const previous of [...this.children]) previous.remove()
    for (const child of children)
      for (const next of child.tag === 'fragment' ? [...child.children] : [child]) this.append(next)
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  querySelectorAll(tag: string): Node[] {
    return this.children.flatMap((node) => [
      ...(node.tag === tag ? [node] : []),
      ...node.querySelectorAll(tag),
    ])
  }
  scrollTo(x: number, y: number) {
    this.scrollLeft = x
    this.scrollTop = y
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const touches = (distance: number, x = 180, y = 200) => [
  { clientX: x - distance / 2, clientY: y },
  { clientX: x + distance / 2, clientY: y },
]

async function viewer(count = 120) {
  const scroll = new Node('scroll')
  const pages = new Node('pages')
  const status = new Node('status')
  const frames = new Map<number, () => void>()
  const timers = new Map<number, () => void>()
  const events = new Map<string, () => void>()
  const renders: number[] = []
  const messages: { type: string; page?: number; pages?: number; uri?: string; url?: string }[] = []
  let id = 0
  let destroyed = 0
  let workers = 0
  let terminated = 0
  let inFlight = 0
  let maxInFlight = 0
  let holdNextRaster = false
  let releaseRaster = () => {}
  const pdfTask = {
    promise: Promise.resolve({
      numPages: count,
      async getPage(number: number) {
        // Alternate portrait and landscape pages to exercise per-page geometry.
        const [width, height] = number % 2 ? [600, 800] : [800, 400]
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await Promise.resolve()
        inFlight--
        return {
          getViewport: ({ scale }: { scale: number }) => ({
            width: width * scale,
            height: height * scale,
            convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
          }),
          streamTextContent: () => ({}),
          getAnnotations: () =>
            Promise.resolve([
              { subtype: 'Link', rect: [0, 0, 100, 50], url: 'https://example.com/' },
            ]),
          render() {
            renders.push(number)
            const promise = holdNextRaster
              ? new Promise<void>((resolve) => {
                  releaseRaster = resolve
                })
              : Promise.resolve()
            holdNextRaster = false
            return { promise, cancel: () => releaseRaster() }
          },
          cleanup() {},
        }
      },
    }),
    async destroy() {
      destroyed++
    },
  }
  const window = {
    devicePixelRatio: 2,
    typoPdf: undefined as unknown as { load(uri: string): void },
    ReactNativeWebView: { postMessage: (message: string) => messages.push(JSON.parse(message)) },
    addEventListener: (type: string, callback: () => void) => events.set(type, callback),
  }
  runInNewContext(code, {
    window,
    document: {
      getElementById: (id: string) => ({ scroll, pages, status })[id],
      createElement: (tag: string) => new Node(tag),
      createDocumentFragment: () => new Node('fragment'),
    },
    pdfTask,
    AbortController,
    Blob,
    URL: { createObjectURL: () => 'blob:worker', revokeObjectURL() {} },
    Worker: class {
      constructor() {
        workers++
      }
      terminate() {
        terminated++
      }
    },
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++id, callback)
      return id
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (callback: () => void) => {
      timers.set(++id, callback)
      return id
    },
    clearTimeout: (id: number) => timers.delete(id),
  })
  const frame = async () => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback()
    await settle()
  }
  window.typoPdf.load('file:///first.pdf')
  await settle()
  return {
    scroll,
    pages,
    frames,
    renders,
    messages,
    frame,
    counts: () => ({ destroyed, workers, terminated, maxInFlight }),
    load: (uri: string) => window.typoPdf.load(uri),
    holdNextRaster: () => {
      holdNextRaster = true
    },
    release: async () => {
      releaseRaster()
      await settle()
    },
    async close() {
      releaseRaster()
      events.get('pagehide')?.()
      await settle()
      expect(destroyed).toBeGreaterThan(0)
    },
  }
}

test('visible pages precede overscan, including document edges and one-page documents', () => {
  expect(viewportPages(100, 102, 200)).toEqual({
    first: 99,
    last: 103,
    order: [100, 101, 102, 99, 103],
  })
  expect(viewportPages(0, 1, 200).order).toEqual([0, 1, 2])
  expect(viewportPages(198, 199, 200).order).toEqual([198, 199, 197])
  expect(viewportPages(0, 0, 1).order).toEqual([0])
})

test('page placeholders ask for sizes in bounded batches and keep document order', async () => {
  const view = await viewer()
  try {
    expect(view.counts().maxInFlight).toBe(16)
    expect(view.pages.children).toHaveLength(120)
    expect(view.pages.children[0].properties.get('--page-ratio')).toBe(String(800 / 600))
    expect(view.pages.children[1].properties.get('--page-ratio')).toBe(String(400 / 800))
  } finally {
    await view.close()
  }
})

test('every page carries its own number and total, including three-digit counts', async () => {
  const view = await viewer(100)
  try {
    const labels = view.pages.children.map((page) => page.attributes.get('data-page'))
    expect(labels[0]).toBe('1 / 100')
    expect(labels[9]).toBe('10 / 100')
    expect(labels[99]).toBe('100 / 100')
    expect(view.pages.children[99].attributes.get('aria-label')).toBe('Page 100 of 100')
  } finally {
    await view.close()
  }
})

test('a distant jump renders visible mixed-size pages first and keeps a bounded cache', async () => {
  const view = await viewer()
  try {
    const start = view.pages.querySelectorAll('canvas')
    expect(start).toHaveLength(3)
    const target = view.pages.children[100]
    view.scroll.clientHeight = 500
    view.scroll.scrollTop = target.offsetTop
    view.renders.length = 0
    view.scroll.dispatch('scroll')
    await view.frame()
    expect(view.renders).toEqual([101, 102, 100, 103])
    expect(view.pages.children[100].children[0].height).toBe(896)
    expect(view.pages.children[101].children[0].height).toBe(336)
    // The pages of the first view stay behind for a scroll back.
    expect(view.pages.querySelectorAll('canvas')).toHaveLength(7)

    // A second jump keeps the newest four pages and releases the older canvases.
    const stale = view.pages.children[0].children[0]
    const recent = view.pages.children[100].children[0]
    view.scroll.scrollTop = view.pages.children[50].offsetTop
    view.scroll.dispatch('scroll')
    await view.frame()
    expect(stale.parent).toBeNull()
    expect(stale.width).toBe(1)
    expect(stale.height).toBe(1)
    expect(recent.parent).toBe(view.pages.children[100])
    expect(view.pages.querySelectorAll('canvas')).toHaveLength(8)
  } finally {
    await view.close()
  }
})

test('scrolling away and back reuses the cached canvases', async () => {
  const view = await viewer()
  try {
    const show = async (index: number) => {
      view.scroll.scrollTop = view.pages.children[index].offsetTop
      view.scroll.dispatch('scroll')
      await view.frame()
    }
    view.scroll.clientHeight = 500
    view.renders.length = 0
    await show(100)
    expect(view.renders).toEqual([101, 102, 100, 103])
    view.renders.length = 0
    await show(95)
    expect(view.renders).toHaveLength(4)
    view.renders.length = 0
    await show(100)
    expect(view.renders).toEqual([])
    expect(view.pages.children[100].querySelectorAll('canvas')).toHaveLength(1)
  } finally {
    await view.close()
  }
})

test('a scroll that still needs the page in flight lets its raster finish', async () => {
  const view = await viewer()
  try {
    view.scroll.clientHeight = 500
    view.scroll.scrollTop = view.pages.children[100].offsetTop
    view.renders.length = 0
    view.holdNextRaster()
    view.scroll.dispatch('scroll')
    await view.frame()
    expect(view.renders).toEqual([101])
    view.scroll.scrollTop = view.pages.children[101].offsetTop
    view.scroll.dispatch('scroll')
    await view.frame()
    await view.release()
    await view.frame()
    expect(
      view.messages.filter((message) => message.type === 'rendered' && message.page === 101)
    ).toHaveLength(1)
    expect(view.renders).toEqual([101, 102, 103, 104])
  } finally {
    await view.close()
  }
})

test('a rendered page gets a selectable text layer and clickable link annotations', async () => {
  const view = await viewer(1)
  try {
    const page = view.pages.children[0]
    const textLayer = page.children.find((child) => child.className === 'textLayer')
    const linkLayer = page.children.find((child) => child.className === 'linkLayer')
    expect(textLayer?.children.map((child) => child.textContent)).toEqual(['selectable'])
    expect(linkLayer?.children).toHaveLength(1)
    expect(linkLayer?.children[0].style.left).toBe('0%')
    expect(linkLayer?.children[0].style.width).toBe(`${(100 * 100) / 600}%`)
    linkLayer?.children[0].dispatch('click')
    expect(view.messages).toContainEqual({ type: 'link', url: 'https://example.com/' })
  } finally {
    await view.close()
  }
})

test('opening another PDF reuses the worker until the viewer unloads', async () => {
  const view = await viewer()
  try {
    expect(view.counts().workers).toBe(1)
    view.load('file:///second.pdf')
    await settle()
    expect(view.messages.at(-1)?.uri).toBe('file:///second.pdf')
    expect(view.counts().workers).toBe(1)
    expect(view.counts().terminated).toBe(0)
    await view.close()
    expect(view.counts().terminated).toBe(1)
  } finally {
    await view.close()
  }
})

test('a superseded raster cannot publish a canvas after a jump or source change', async () => {
  const view = await viewer()
  try {
    view.holdNextRaster()
    view.scroll.scrollTop = view.pages.children[100].offsetTop
    view.scroll.dispatch('scroll')
    await view.frame()
    expect(view.renders.at(-1)).toBe(101)
    view.scroll.scrollTop = view.pages.children[50].offsetTop
    view.scroll.dispatch('scroll')
    await view.frame()
    expect(view.pages.children[100].children).toHaveLength(0)
    expect(
      view.messages.some((message) => message.type === 'rendered' && message.page === 101)
    ).toBe(false)
    expect(view.pages.children[50].querySelectorAll('canvas')).toHaveLength(1)

    view.holdNextRaster()
    view.scroll.scrollTop = view.pages.children[80].offsetTop
    view.scroll.dispatch('scroll')
    await view.frame()
    expect(view.renders.at(-1)).toBe(81)
    view.load('file:///second.pdf')
    await settle()
    expect(
      view.messages.some((message) => message.page === 81 && message.uri === 'file:///first.pdf')
    ).toBe(false)
    expect(view.messages.at(-1)?.uri).toBe('file:///second.pdf')
  } finally {
    await view.close()
  }
})

test('pinch coalesces moves per frame and flushes the last anchored zoom before raster', async () => {
  const view = await viewer()
  try {
    view.renders.length = 0
    view.scroll.dispatch('touchstart', touches(100))
    for (const distance of [120, 150, 200]) view.scroll.dispatch('touchmove', touches(distance))
    expect(view.pages.properties.get('--page-width')).toBe('336px')
    expect(view.frames.size).toBe(1)
    await view.frame()
    expect(view.pages.properties.get('--page-width')).toBe('672px')
    expect(view.scroll.scrollLeft).toBe(156)
    expect(view.scroll.scrollTop).toBe(176)
    expect(view.renders).toEqual([])
    view.scroll.dispatch('touchmove', touches(250))
    view.scroll.dispatch('touchmove', touches(300))
    view.scroll.dispatch('touchend')
    expect(view.frames.size).toBe(0)
    expect(view.pages.properties.get('--page-width')).toBe('1008px')
    expect(view.scroll.scrollLeft).toBe(312)
    expect(view.scroll.scrollTop).toBe(352)
    await settle()
    expect(view.renders[0]).toBe(1)
    expect(view.pages.children[0].children[0].width).toBe(pageLayout(600, 800, 384, 3, 2).width)
  } finally {
    await view.close()
  }
})

test('touch cancellation flushes pinch and source switching drops its pending frame', async () => {
  const view = await viewer()
  try {
    view.scroll.dispatch('touchstart', touches(100))
    view.scroll.dispatch('touchmove', touches(150))
    view.scroll.dispatch('touchcancel')
    expect(view.frames.size).toBe(0)
    expect(view.pages.properties.get('--page-width')).toBe('504px')
    await settle()
    view.scroll.dispatch('touchstart', touches(100))
    view.scroll.dispatch('touchmove', touches(200))
    expect(view.frames.size).toBe(1)
    view.load('file:///second.pdf')
    expect(view.frames.size).toBe(0)
    await settle()
    expect(view.pages.properties.get('--page-width')).toBe('504px')
    expect(view.messages.at(-1)?.uri).toBe('file:///second.pdf')
  } finally {
    await view.close()
  }
})
