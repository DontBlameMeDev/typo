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

function search() {
  const module = { exports: {} }
  runInNewContext(source, {
    module,
    exports: module.exports,
    __DEV__: false,
    require(name: string) {
      if (name === 'react')
        return {
          useRef: (current: unknown) => ({ current: current === 0 ? 7 : current }),
          useState: (value: unknown) => [value === null ? 'file:///search.html' : value, () => {}],
          useEffect: () => {},
          useCallback: (callback: unknown) => callback,
        }
      if (name === 'react/jsx-runtime' || name === 'react/jsx-dev-runtime') {
        const element = (type: unknown, props: unknown) => ({ type, props })
        return { jsx: element, jsxDEV: element }
      }
      if (name === 'react-native') return { View: 'View' }
      if (name === 'react-native-webview') return { WebView: 'WebView' }
      if (name.endsWith('/editor/document')) return { inlineJson: JSON.stringify }
      if (name.endsWith('/web-runtime')) return { webRuntime: async () => 'file:///search.html' }
      throw new Error(`Unexpected import: ${name}`)
    },
  })
  const callbacks = { onResults: mock(), onError: mock(), onPending: mock() }
  const { NoteSearch: render } = module.exports as {
    NoteSearch: (props: ComponentProps<typeof NoteSearch>) => {
      props: {
        children: { props: { onMessage(event: unknown): void; onRenderProcessGone(): void } }
      }
    }
  }
  const view = render({ notes: [], query: 'query', mode: 'names', ...callbacks }).props.children
    .props
  return {
    ...callbacks,
    message: (data: unknown) => view.onMessage({ nativeEvent: { data: JSON.stringify(data) } }),
    stopped: view.onRenderProcessGone,
  }
}

test('stale search failures do not reject a current response', () => {
  const api = search()
  api.message({ type: 'error', id: 6, message: 'Stale' })
  api.message({ type: 'results', id: 7, results: [] })
  expect(api.onError).not.toHaveBeenCalled()
  expect(api.onResults).toHaveBeenCalledWith([])
  expect(api.onPending).toHaveBeenLastCalledWith(false)
})

test('search failures reject without reporting a successful empty search or accepting late results', () => {
  const api = search()
  api.message({ type: 'error', id: 7, message: 'Broken' })
  api.message({ type: 'results', id: 7, results: [] })
  expect(api.onError).toHaveBeenCalledWith('Broken')
  expect(api.onResults).not.toHaveBeenCalled()
  expect(api.onPending).toHaveBeenLastCalledWith(false)
})

test('a stopped search process cannot publish its last response', () => {
  const api = search()
  api.stopped()
  api.message({ type: 'results', id: 7, results: [] })
  expect(api.onError).toHaveBeenCalledWith('The note search stopped and is restarting.')
  expect(api.onResults).not.toHaveBeenCalled()
})
