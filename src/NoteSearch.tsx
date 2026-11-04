import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { WebView } from 'react-native-webview'
import { inlineJson } from './editor/document'
import { type SearchHit, SearchTransport } from './search/protocol'
import type { Note, SearchMode, SearchResult } from './types'
import { webRuntime } from './web-runtime'

type Props = {
  notes: Note[]
  query: string
  mode: SearchMode
  onResults(results: SearchResult[]): void
  onError(message: string): void
  onPending?(pending: boolean): void
}

export function NoteSearch(props: Props) {
  const latest = useRef(props)
  latest.current = props
  const web = useRef<WebView<object>>(null)
  const transport = useRef(new SearchTransport())
  const sequence = useRef(0)
  const requested = useRef<{ at: number; mode: SearchMode } | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [started, setStarted] = useState(false)
  const [session, setSession] = useState(0)
  const fail = useCallback((message: string) => {
    sequence.current++
    requested.current = null
    latest.current.onPending?.(false)
    latest.current.onError(message)
  }, [])

  useEffect(() => {
    props.onPending?.(!!props.query.trim())
    if (props.notes.length || props.query.trim()) setStarted(true)
  }, [props.notes.length, props.query, props.onPending])
  useEffect(() => {
    if (!started) return
    let cancelled = false
    void webRuntime('search').then(
      (path) => {
        if (!cancelled) setUri(path)
      },
      (cause) => {
        if (!cancelled) fail(String(cause))
      }
    )
    return () => {
      cancelled = true
    }
  }, [started, fail])
  useEffect(() => {
    if (!ready) return
    const request = transport.current.request(props.notes, props.query, props.mode)
    if (request) {
      requested.current = { at: performance.now(), mode: props.mode }
      latest.current.onPending?.(!!props.query.trim())
      web.current?.injectJavaScript(
        `window.typoSearch(${inlineJson({ ...request, id: ++sequence.current })});true;`
      )
    }
  }, [props.notes, props.query, props.mode, ready])

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
    >
      {uri && (
        <WebView<object>
          key={session}
          ref={web}
          source={{ uri }}
          originWhitelist={['file://*']}
          allowFileAccess
          javaScriptEnabled
          domStorageEnabled={false}
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) =>
            request.url === uri || request.url === 'about:blank'
          }
          onError={() => fail('The note search could not load.')}
          onRenderProcessGone={() => {
            setReady(false)
            setSession((value) => value + 1)
            fail('The note search stopped and is restarting.')
          }}
          onMessage={(event) => {
            try {
              const message = JSON.parse(event.nativeEvent.data)
              if (message.type === 'boot') {
                transport.current = new SearchTransport()
                setReady(true)
              } else if (message.type === 'error') {
                if (message.id == null || message.id === sequence.current)
                  fail(String(message.message))
              } else if (message.type === 'results' && message.id === sequence.current) {
                if (!Array.isArray(message.results)) throw new Error('Invalid search results')
                const notes = new Map(latest.current.notes.map((note) => [note.path, note]))
                const results: SearchResult[] = []
                for (const hit of message.results as SearchHit[]) {
                  const note = notes.get(hit.path)
                  if (note) results.push({ note, line: hit.line, snippet: hit.snippet })
                }
                if (__DEV__ && requested.current && latest.current.query.trim())
                  console.info(
                    `[performance] ${requested.current.mode === 'names' ? 'Names' : 'Everywhere'} search round trip: ${(performance.now() - requested.current.at).toFixed(1)} ms`
                  )
                latest.current.onPending?.(false)
                latest.current.onResults(results)
              }
            } catch {
              fail('The note search sent an invalid response.')
            }
          }}
        />
      )}
    </View>
  )
}
