import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

const modules: Record<string, string> = {
  react: 'export const {useEffect,useRef,useState}=globalThis.hooks',
  'react/jsx-runtime': 'export const jsx=globalThis.jsx,jsxs=globalThis.jsx',
  'expo-file-system/legacy': 'export const cacheDirectory="file:///cache/"',
  'react-native': `export const View="View",ActivityIndicator="ActivityIndicator";
    export const StyleSheet={create:styles=>styles}`,
  'react-native-webview': 'export const WebView="WebView"',
  './editor/document': 'export const inlineJson=JSON.stringify',
  './theme':
    'export const useTheme=()=>({colors:{soft:"#eee",ink:"#222",accent:"#555",muted:"#666"}})',
  './web-runtime': `export const afterPaint=callback=>{callback();return ()=>{}};
    export const webRuntime=async()=>"file:///runtime/pdf.html"`,
}
const build = await Bun.build({
  entrypoints: [`${import.meta.dir}/../src/PdfViewer.tsx`],
  target: 'browser',
  format: 'cjs',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'native-host-test',
      setup(builder) {
        builder.onResolve({ filter: /^(react|expo-file-system|\.\/)/ }, (args) =>
          modules[args.path] ? { path: args.path, namespace: 'host-test' } : undefined
        )
        builder.onLoad({ filter: /.*/, namespace: 'host-test' }, (args) => ({
          contents: modules[args.path],
          loader: 'js',
        }))
      },
    },
  ],
})
if (!build.success) throw new AggregateError(build.logs, 'Cannot build the PDF host test.')
const code = await build.outputs[0].text()

type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void }
type Props = { source: { uri: string } | null; onError: (cause: Error) => void }

async function host() {
  const slots: Slot[] = []
  const effects: (() => void)[] = []
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const injections: string[] = []
  const errors: Error[] = []
  let cursor = 0
  let timerId = 0
  let dirty = true
  let props: Props = { source: { uri: 'file:///a.pdf' }, onError: (cause) => errors.push(cause) }
  let web: { onMessage: (event: { nativeEvent: { data: string } }) => void } | undefined
  const slot = () => {
    const index = cursor++
    slots[index] ??= {}
    return slots[index]
  }
  const module = { exports: {} }
  runInNewContext(code, {
    module,
    hooks: {
      useRef(initial: unknown) {
        const current = slot()
        current.value ??= { current: initial }
        return current.value
      },
      useState(initial: unknown) {
        const current = slot()
        if (!('value' in current)) current.value = initial
        return [
          current.value,
          (value: unknown) => {
            if (Object.is(current.value, value)) return
            current.value = value
            dirty = true
          },
        ]
      },
      useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
        const current = slot()
        if (current.deps?.every((value, index) => Object.is(value, deps[index]))) return
        current.deps = deps
        effects.push(() => {
          current.cleanup?.()
          current.cleanup = effect()
        })
      },
    },
    jsx(type: string, properties: Record<string, unknown>) {
      if (type === 'WebView') {
        web = properties as typeof web
        const ref = properties.ref as { current: unknown }
        ref.current = { injectJavaScript: (script: string) => injections.push(script) }
      }
      return { type, properties }
    },
    setTimeout(callback: () => void, delay: number) {
      timers.set(++timerId, { callback, delay })
      return timerId
    },
    clearTimeout(id: number) {
      timers.delete(id)
    },
  })
  const render = (module.exports as { default: (props: Props) => unknown }).default
  let tree: unknown
  const flush = () => {
    let renders = 0
    while (dirty) {
      if (++renders > 20) throw new Error('PDF host did not settle')
      dirty = false
      cursor = 0
      tree = render(props)
      for (const effect of effects.splice(0)) effect()
    }
  }
  flush()
  await new Promise((resolve) => setImmediate(resolve))
  flush()
  return {
    errors,
    injections,
    flush,
    spinner() {
      const visit = (node: unknown): boolean => {
        if (!node || typeof node !== 'object') return false
        const element = node as { type?: string; properties?: { children?: unknown } }
        if (element.type === 'ActivityIndicator') return true
        const children = element.properties?.children
        return (Array.isArray(children) ? children : [children]).some(visit)
      }
      return visit(tree)
    },
    webOpacity: () =>
      (web as unknown as { style?: { opacity?: number } } | undefined)?.style?.opacity,
    runTimers(delay: number) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay) continue
        timers.delete(id)
        timer.callback()
      }
      flush()
    },
    waitingForPage: () => [...timers.values()].some((timer) => timer.delay === 60_000),
    message(message: object, settle = true) {
      if (!web) throw new Error('WebView did not mount')
      web.onMessage({ nativeEvent: { data: JSON.stringify(message) } })
      if (settle) flush()
    },
    source(uri: string) {
      props = { ...props, source: { uri } }
      dirty = true
      flush()
    },
    suspend() {
      props = { ...props, source: null }
      dirty = true
      flush()
    },
    refreshEffects() {
      for (const current of slots) current.deps = undefined
      dirty = true
      flush()
    },
  }
}

test('a fast first render is not reset by the boot load effect', async () => {
  const viewer = await host()
  viewer.message({ type: 'boot' }, false)
  expect(viewer.injections[0]).toContain('"scrollbar":"#666"')
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' }, false)
  viewer.flush()
  expect(viewer.waitingForPage()).toBe(false)
  expect(viewer.injections.filter((script) => script.includes('.load('))).toHaveLength(1)
})

test('late rendered messages cannot undo the current PDF acknowledgement', async () => {
  const viewer = await host()
  viewer.message({ type: 'boot' })
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' })
  viewer.source('file:///b.pdf')
  expect(viewer.waitingForPage()).toBe(true)
  viewer.message({ type: 'rendered', uri: 'file:///b.pdf' })
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' })
  expect(viewer.waitingForPage()).toBe(false)
})

test('returning to an earlier URI requires a new render acknowledgement', async () => {
  const viewer = await host()
  viewer.message({ type: 'boot' })
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' })
  viewer.source('file:///b.pdf')
  viewer.source('file:///a.pdf')
  expect(viewer.waitingForPage()).toBe(true)
  viewer.message({ type: 'rendered', uri: 'file:///b.pdf' })
  expect(viewer.waitingForPage()).toBe(true)
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' })
  expect(viewer.waitingForPage()).toBe(false)
})

test('refreshing effects does not reset an already displayed source', async () => {
  const viewer = await host()
  viewer.message({ type: 'boot' })
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' })
  viewer.refreshEffects()
  expect(viewer.waitingForPage()).toBe(false)
  viewer.message({ type: 'boot' })
  expect(viewer.waitingForPage()).toBe(true)
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' })
  expect(viewer.waitingForPage()).toBe(false)
})

test('a loading indicator covers the PDF until the first page is displayed', async () => {
  const viewer = await host()
  viewer.message({ type: 'boot' })
  expect(viewer.spinner()).toBe(false)
  viewer.runTimers(120)
  expect(viewer.spinner()).toBe(true)
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' })
  expect(viewer.spinner()).toBe(false)
})

test('a new PDF stays hidden until its first page is rendered', async () => {
  const viewer = await host()
  viewer.message({ type: 'boot' })
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' })
  viewer.source('file:///b.pdf')
  expect(viewer.spinner()).toBe(false)
  expect(viewer.webOpacity()).toBe(0)
  viewer.runTimers(120)
  expect(viewer.spinner()).toBe(true)
  viewer.message({ type: 'rendered', uri: 'file:///b.pdf' })
  expect(viewer.spinner()).toBe(false)
  expect(viewer.webOpacity()).toBe(1)
})

test('a render acknowledgement is kept while the source is pending', async () => {
  const viewer = await host()
  viewer.message({ type: 'boot' })
  viewer.suspend()
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' })
  viewer.source('file:///a.pdf')
  expect(viewer.spinner()).toBe(false)
  expect(viewer.webOpacity()).toBe(1)
})
