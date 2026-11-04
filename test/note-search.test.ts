import { expect, mock, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import type { ComponentProps } from 'react'
import type { NoteSearch } from '../src/NoteSearch'

const bundle = await Bun.build({
  entrypoints: ['src/NoteSearch.tsx'],
  target: 'node',
  format: 'cjs',
  external: ['react', 'react-native', 'react-native-webview'],
  plugins: [
    {
      name: 'search-host-stubs',
      setup(build) {
        build.onResolve({ filter: /(?:editor\/document|web-runtime)$/u }, (args) => ({
          path: args.path,
          external: true,
        }))
      },
    },
  ],
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot bundle note search')
const source = await bundle.outputs[0].text()

type Props = ComponentProps<typeof NoteSearch>
type Element = { type: unknown; props: Record<string, unknown> }
type Scope = { props: Record<string, unknown> }

function callbacks() {
  return { onResults: mock(), onError: mock(), onPending: mock() }
}

function search(initial: Omit<Props, 'onResults' | 'onError' | 'onPending'>, failRuntime = false) {
  const hooks = callbacks()
  let props: Props = { ...initial, ...hooks }
  let cursor = 0
  let dirty = false
  let view: Element | null = null
  const cleanups: (undefined | (() => void))[] = []
  const deps: (unknown[] | undefined)[] = []
  const effects: { deps?: unknown[]; run(): undefined | (() => void) }[] = []
  const memo: { deps?: unknown[]; value?: unknown }[] = []
  const refs: { current: unknown }[] = []
  const states: unknown[] = []
  const runtime = { calls: 0, fail: failRuntime }

  const react = {
    useRef(value: unknown) {
      const index = cursor++
      refs[index] ??= { current: value }
      return refs[index]
    },
    useState(value: unknown) {
      const index = cursor++
      return [
        index in states ? states[index] : value,
        (next: unknown) => {
          const resolved =
            typeof next === 'function' ? (next as (old: unknown) => unknown)(states[index]) : next
          if (resolved !== states[index]) {
            states[index] = resolved
            dirty = true
          }
        },
      ]
    },
    useEffect(run: () => undefined | (() => void), next?: unknown[]) {
      effects[cursor++] = { deps: next, run }
    },
    useCallback(callback: unknown, next?: unknown[]) {
      const index = cursor++
      const previous = memo[index]
      if (previous?.deps?.every((value, position) => value === next?.[position]))
        return previous.value
      memo[index] = { deps: next, value: callback }
      return callback
    },
  }

  const module = { exports: {} }
  runInNewContext(source, {
    module,
    exports: module.exports,
    __DEV__: false,
    require(name: string) {
      if (name === 'react') return react
      if (name === 'react-native') return { View: 'View' }
      if (name === 'react-native-webview') return { WebView: 'WebView' }
      if (name === 'react/jsx-runtime' || name === 'react/jsx-dev-runtime') {
        const element = (type: unknown, props: unknown) => ({ type, props })
        return { jsx: element, jsxDEV: element }
      }
      if (name.endsWith('/editor/document')) return { inlineJson: JSON.stringify }
      if (name.endsWith('/web-runtime'))
        return {
          webRuntime: async () => {
            runtime.calls++
            if (runtime.fail) throw new Error('Missing bundle')
            return 'file:///search.html'
          },
        }
      throw new Error(`Unexpected import: ${name}`)
    },
  })

  const { NoteSearch: Component } = module.exports as {
    NoteSearch: (props: Props) => Element
  }
  const render = () => {
    cursor = 0
    view = Component(props)
    for (const [index, effect] of effects.entries()) {
      if (!effect) continue
      const previous = deps[index]
      if (previous && effect.deps?.every((value, position) => value === previous[position]))
        continue
      cleanups[index]?.()
      deps[index] = effect.deps
      cleanups[index] = effect.run()
    }
  }
  const settle = async () => {
    for (let pass = 0; pass < 10; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!dirty) return
      dirty = false
      render()
    }
  }
  render()

  const child = () => {
    const children = (view as Element).props.children
    if (!children) throw new Error('No search WebView')
    return (children as Scope).props as {
      source: { uri: string }
      onMessage(event: unknown): void
      onError(): void
      onRenderProcessGone(): void
    }
  }
  return {
    ...hooks,
    runtime,
    settle,
    setProps(next: Partial<Props>) {
      props = { ...props, ...next }
      dirty = true
      render()
    },
    child,
    message(data: unknown) {
      child().onMessage({ nativeEvent: { data: JSON.stringify(data) } })
    },
  }
}

test('stale search failures do not reject a current response', async () => {
  const api = search({ notes: [], query: 'query', mode: 'names' })
  await api.settle()
  api.message({ type: 'error', id: -1, message: 'Stale' })
  api.message({ type: 'results', id: 0, results: [] })
  expect(api.onError).not.toHaveBeenCalled()
  expect(api.onResults).toHaveBeenCalledWith([])
})

test('search failures reject without reporting a successful empty search or accepting late results', async () => {
  const api = search({ notes: [], query: 'query', mode: 'names' })
  await api.settle()
  api.message({ type: 'error', id: 0, message: 'Broken' })
  api.message({ type: 'results', id: 0, results: [] })
  expect(api.onError).toHaveBeenCalledWith('Broken')
  expect(api.onResults).not.toHaveBeenCalled()
})

test('a stopped search process cannot publish its last response', async () => {
  const api = search({ notes: [], query: 'query', mode: 'names' })
  await api.settle()
  api.child().onRenderProcessGone()
  api.message({ type: 'results', id: 0, results: [] })
  expect(api.onError).toHaveBeenCalledWith('The note search stopped and is restarting.')
  expect(api.onResults).not.toHaveBeenCalled()
})

test('a runtime load failure retries after the next query', async () => {
  const api = search({ notes: [], query: 'query', mode: 'names' }, true)
  await api.settle()
  expect(api.onError).toHaveBeenCalledWith('Error: Missing bundle')
  expect(api.runtime.calls).toBe(1)
  api.runtime.fail = false
  api.setProps({ query: 'next' })
  await api.settle()
  expect(api.runtime.calls).toBe(2)
  expect(api.child().source.uri).toBe('file:///search.html')
})

test('a WebView load error remounts after the next query', async () => {
  const api = search({ notes: [], query: 'query', mode: 'names' })
  await api.settle()
  api.child().onError()
  expect(api.onError).toHaveBeenCalledWith('The note search could not load.')
  await api.settle()
  expect(() => api.child()).toThrow()
  api.setProps({ query: 'next' })
  await api.settle()
  expect(api.child().source.uri).toBe('file:///search.html')
})
