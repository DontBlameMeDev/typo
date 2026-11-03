import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Keyboard, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { inlineJson } from './editor/document'
import { editorMessage } from './editor/protocol'
import { useTheme } from './theme'
import { webRuntime } from './web-runtime'

export type SourceEditorHandle = { focus: () => void; blur: () => void }
type Props = {
  documentId: string
  value: string
  onChangeText: (source: string) => void
  selection?: { start: number; end: number }
  editable: boolean
  waitForKeyboardHide: boolean
  onError: (message: string) => void
  onPainted: () => void
  onSave: (source: string) => void
}

export const SourceEditor = forwardRef<SourceEditorHandle, Props>(
  function SourceEditor(props, ref) {
    const { colors, palette } = useTheme()
    const web = useRef<WebView<object>>(null)
    const latest = useRef(props)
    latest.current = props
    const echoes = useRef(new Set<string>())
    const documentId = useRef(props.documentId)
    const failure = useRef<string | null>(null)
    const fail = useCallback((message: string) => {
      failure.current = message
      latest.current.onError(message)
    }, [])
    const [uri, setUri] = useState<string | null>(null)
    const [ready, setReady] = useState(false)
    const theme = {
      background: colors.paper,
      foreground: colors.ink,
      muted: colors.muted,
      accent: colors.accent,
      selection: palette.surface1,
      syntax: {
        constant: palette.text,
        variable: palette.text,
        function: palette.blue,
        keyword: palette.mauve,
        punctuation: palette.overlay2,
        number: palette.peach,
        string: palette.green,
        raw: palette.teal,
        comment: palette.overlay2,
        heading: colors.accent,
        strong: palette.text,
        italic: palette.text,
        link: palette.sapphire,
        math: palette.yellow,
      },
    }
    const themeJson = inlineJson(theme)
    const inject = (script: string) => web.current?.injectJavaScript(`${script};true;`)
    useImperativeHandle(ref, () => ({
      focus: () => inject('window.typoEditor?.focus()'),
      blur: () => inject('window.typoEditor?.blur()'),
    }))

    useEffect(() => {
      let cancelled = false
      void webRuntime('editor')
        .then((path) => {
          if (!cancelled) setUri(path)
        })
        .catch((cause: unknown) => {
          if (!cancelled) fail(cause instanceof Error ? cause.message : 'Cannot load the editor.')
        })
      return () => {
        cancelled = true
      }
    }, [fail])

    useLayoutEffect(() => {
      if (documentId.current !== props.documentId) {
        documentId.current = props.documentId
        echoes.current.clear()
      }
      if (failure.current) {
        latest.current.onError(failure.current)
        return
      }
      if (ready && !echoes.current.delete(props.value))
        web.current?.injectJavaScript(
          `window.typoEditor?.setDocument(${inlineJson(props.documentId)},${inlineJson(props.value)});true;`
        )
    }, [props.documentId, props.value, ready])
    useLayoutEffect(() => {
      if (ready) web.current?.injectJavaScript(`window.typoEditor?.setTheme(${themeJson});true;`)
    }, [themeJson, ready])
    useLayoutEffect(() => {
      if (ready)
        web.current?.injectJavaScript(`window.typoEditor?.setEditable(${props.editable});true;`)
    }, [props.editable, ready])
    useLayoutEffect(() => {
      if (ready && props.selection)
        web.current?.injectJavaScript(
          `window.typoEditor?.select(${props.selection.start},${props.selection.end});true;`
        )
    }, [props.selection, ready])
    useLayoutEffect(() => {
      if (!ready) return
      const subscription = Keyboard.addListener('keyboardDidHide', () => {
        web.current?.injectJavaScript('window.typoEditor?.measure?.();true;')
      })
      return () => subscription.remove()
    }, [ready])

    return (
      <View
        style={{ flex: 1, backgroundColor: colors.paper }}
        onLayout={() => {
          if (ready) inject('window.typoEditor?.measure?.()')
        }}
      >
        {uri && (
          <WebView<object>
            ref={web}
            source={{ uri }}
            style={{ flex: 1, backgroundColor: colors.paper }}
            originWhitelist={['file://*']}
            allowFileAccess
            allowFileAccessFromFileURLs
            javaScriptEnabled
            domStorageEnabled={false}
            setSupportMultipleWindows={false}
            onShouldStartLoadWithRequest={(request) =>
              request.url === uri || request.url === 'about:blank'
            }
            onLoadEnd={() => {
              if (!ready)
                inject(
                  `window.typoStart?.(${inlineJson({ documentId: latest.current.documentId, source: latest.current.value, editable: latest.current.editable, theme })})`
                )
            }}
            onError={() => {
              setReady(false)
              fail('The editor could not load. Your file has not been changed.')
            }}
            onRenderProcessGone={() => {
              setReady(false)
              web.current?.reload()
              fail('The editor stopped and is restarting. Your file has not been changed.')
            }}
            onMessage={(event) => {
              try {
                const message = editorMessage(
                  event.nativeEvent.data,
                  latest.current.documentId,
                  latest.current.value
                )
                if (!message) return
                if (message.type === 'boot')
                  inject(
                    `window.typoStart(${inlineJson({ documentId: latest.current.documentId, source: latest.current.value, editable: latest.current.editable, theme })})`
                  )
                else if (message.type === 'ready') {
                  failure.current = null
                  setReady(true)
                } else if (message.type === 'painted') {
                  if (!latest.current.waitForKeyboardHide || !Keyboard.isVisible())
                    latest.current.onPainted()
                } else if (message.type === 'change') {
                  echoes.current.add(message.source)
                  if (echoes.current.size > 50)
                    echoes.current.delete(echoes.current.values().next().value ?? '')
                  latest.current.onChangeText(message.source)
                } else if (message.type === 'save') latest.current.onSave(message.source)
                else if (message.type === 'error') fail(message.message)
              } catch {
                fail('The editor sent an invalid response.')
              }
            }}
          />
        )}
      </View>
    )
  }
)
