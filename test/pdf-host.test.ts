import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

const modules: Record<string, string> = {
  react: 'export const {useEffect,useRef,useState}=globalThis.hooks',
  'react/jsx-runtime': 'export const jsx=globalThis.jsx,jsxs=globalThis.jsx',
  'expo-file-system/legacy': 'export const cacheDirectory="file:///cache/"',
  'react-native': `export const View="View",Text="Text",Pressable="Pressable";
    export const StyleSheet={create:styles=>styles,hairlineWidth:1};
    export const Linking={openURL:async()=>{}};
    export const Easing={linear:value=>value};
    class Value{constructor(value){this.value=value}setValue(value){this.value=value}interpolate(){return 0}}
    const animation={start(){},stop(){}};
    export const Animated={Value,View:"AnimatedView",loop:()=>animation,timing:()=>animation}`,
  'react-native-svg': 'export const Svg="Svg",Circle="Circle",Path="Path"',
  'react-native-webview': 'export const WebView="WebView"',
  './about': 'export const issuesUrl="https://example.com/issues"',
  './editor/document': 'export const inlineJson=JSON.stringify',
  './ReportIssue': 'export const ReportIssue="ReportIssue"',
  './theme': `export const useTheme=()=>({colors:{soft:"#eee",ink:"#222",accent:"#555"},palette:{crust:"#11111b",surface0:"#313244",text:"#cdd6f4"}})`,
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
            const next = typeof value === 'function' ? value(current.value) : value
            if (Object.is(current.value, next)) return
            current.value = next
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
    setInterval(callback: () => void, delay: number) {
      const id = ++timerId
      const tick = () => {
        timers.set(id, { callback: tick, delay })
        callback()
      }
      timers.set(id, { callback: tick, delay })
      return id
    },
    clearInterval(id: number) {
      timers.delete(id)
    },
  })
  const render = (module.exports as { default: (props: Props) => unknown }).default
  let tree: unknown
  const types = () => {
    const found: string[] = []
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      const element = node as { type?: string; properties?: { children?: unknown } }
      if (typeof element.type === 'string') found.push(element.type)
      const children = element.properties?.children
      if (Array.isArray(children)) children.forEach(visit)
      else visit(children)
    }
    visit(tree)
    return found
  }
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
      return types().includes('Svg')
    },
    report() {
      return types().includes('ReportIssue')
    },
    texts() {
      const found: string[] = []
      const visit = (node: unknown) => {
        if (!node || typeof node !== 'object') return
        const element = node as { type?: string; properties?: { children?: unknown } }
        const children = element.properties?.children
        if (element.type === 'Text' && typeof children === 'string') found.push(children)
        else if (Array.isArray(children)) children.forEach(visit)
        else visit(children)
      }
      visit(tree)
      return found
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

test('the loading screen rotates its message until the PDF is ready', async () => {
  const viewer = await host()
  viewer.message({ type: 'boot' })
  viewer.runTimers(120)
  expect(viewer.texts()).toContain('Getting ready…')
  viewer.runTimers(3000)
  expect(viewer.texts()).toContain('Removing a Typo…')
  viewer.runTimers(3000)
  expect(viewer.texts()).toContain('Warming up…')
  viewer.runTimers(3000)
  expect(viewer.texts()).toContain('Setting the type…')
  viewer.runTimers(3000)
  expect(viewer.texts()).toContain('Compiling…')
  viewer.runTimers(3000)
  expect(viewer.texts()).toContain('Laying out pages…')
  viewer.message({ type: 'rendered', uri: 'file:///a.pdf' })
  expect(viewer.texts()).toEqual([])
  expect(viewer.report()).toBe(false)
})

test('the loading screen counts the seconds spent compiling', async () => {
  const viewer = await host()
  viewer.message({ type: 'boot' })
  viewer.runTimers(120)
  expect(viewer.texts()).not.toContain('1 second so far')
  viewer.runTimers(1000)
  expect(viewer.texts()).toContain('1 second so far')
  viewer.runTimers(1000)
  expect(viewer.texts()).toContain('2 seconds so far')
})

test('a slow load settles on one message and offers the issue tracker', async () => {
  const viewer = await host()
  viewer.message({ type: 'boot' })
  viewer.runTimers(120)
  expect(viewer.report()).toBe(false)
  viewer.runTimers(10_000)
  expect(viewer.report()).toBe(true)
  expect(viewer.texts()).toContain('Still compiling…')
  viewer.runTimers(3000)
  expect(viewer.texts()).toContain('Still compiling…')
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
