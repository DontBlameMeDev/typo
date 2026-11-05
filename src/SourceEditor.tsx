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
import { applyEditorChange, editorMessage, normalizeSource } from './editor/protocol'
import { useTheme } from './theme'
import { webRuntime } from './web-runtime'

export type SourceEditorHandle = {
  focus: () => void
  blur: () => void
  insert: (text: string) => void
}
type Props = {
  documentId: string
  value: string
  onChangeText: (source: string) => void
  selection?: { start: number; end: number }
  editable: boolean
  waitForKeyboardHide: boolean
  onError: (message: string, fatal?: boolean) => void
  onPainted: () => void
  onFocusChange: (focused: boolean) => void
  onSave: (source: string) => void
}

export const SourceEditor = forwardRef<SourceEditorHandle, Props>(
  function SourceEditor(props, ref) {
    const { colors, palette } = useTheme()
    const web = useRef<WebView<object>>(null)
    const latest = useRef(props)
    latest.current = props
    const mirror = useRef(normalizeSource(props.value))
    const bootValue = useRef<string | null>(null)
    const bootDocument = useRef<string | null>(null)
    const session = useRef(0)
    const synced = useRef(false)
    const documentId = useRef(props.documentId)
    const failure = useRef<string | null>(null)
    const warning = useRef<string | null>(null)
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
        variable: palette.text,
        property: palette.lavender,
        function: palette.blue,
        keyword: palette.mauve,
        punctuation: palette.overlay2,
        operator: palette.sky,
        number: palette.peach,
        string: palette.green,
        raw: palette.teal,
        comment: palette.overlay2,
        heading: palette.blue,
        strong: palette.red,
        italic: palette.yellow,
        link: palette.sapphire,
        math: palette.yellow,
      },
    }
    const themeJson = inlineJson(theme)
    const inject = (script: string) => web.current?.injectJavaScript(`${script};true;`)
    useImperativeHandle(ref, () => ({
      focus: () => inject('window.typoEditor?.focus()'),
      blur: () => inject('window.typoEditor?.blur()'),
      insert: (text) => inject(`window.typoEditor?.insert(${inlineJson(text)})`),
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
      const switched = documentId.current !== props.documentId
      if (switched) {
        documentId.current = props.documentId
        if (warning.current) latest.current.onError(warning.current, false)
      }
      if (failure.current) {
        latest.current.onError(failure.current)
        return
      }
      if (!ready) {
        synced.current = false
        mirror.current = props.value
        return
      }
      if (!synced.current) {
        synced.current = true
        mirror.current = props.value
        // The boot payload already carries this source.
        if (props.value === bootValue.current && props.documentId === bootDocument.current) return
      } else if (!switched && props.value === mirror.current) return
      mirror.current = props.value
      web.current?.injectJavaScript(
        `window.typoEditor?.setDocument(${inlineJson(props.documentId)},${inlineJson(props.value)},${++session.current});true;`
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
              if (ready) return
              bootValue.current = normalizeSource(latest.current.value)
              bootDocument.current = latest.current.documentId
              inject(
                `window.typoStart?.(${inlineJson({ documentId: latest.current.documentId, source: latest.current.value, session: session.current, editable: latest.current.editable, theme })})`
              )
            }}
            onError={() => {
              setReady(false)
              fail('The editor could not load. Your file has not been changed.')
            }}
            onRenderProcessGone={() => {
              setReady(false)
              ++session.current
              latest.current.onFocusChange(false)
              web.current?.reload()
              fail('The editor stopped and is restarting. Your file has not been changed.')
            }}
            onMessage={(event) => {
              try {
                const message = editorMessage(event.nativeEvent.data, latest.current.documentId)
                if (!message) return
                if (message.type === 'boot') {
                  bootValue.current = normalizeSource(latest.current.value)
                  bootDocument.current = latest.current.documentId
                  inject(
                    `window.typoStart(${inlineJson({ documentId: latest.current.documentId, source: latest.current.value, session: session.current, editable: latest.current.editable, theme })})`
                  )
                } else if (message.type === 'ready') {
                  failure.current = null
                  warning.current = null
                  setReady(true)
                } else if (message.type === 'painted') {
                  if (
                    message.session === session.current &&
                    (!latest.current.waitForKeyboardHide || !Keyboard.isVisible())
                  )
                    latest.current.onPainted()
                } else if (message.type === 'change') {
                  if (message.session !== session.current) return
                  try {
                    mirror.current = applyEditorChange(mirror.current, message.change)
                  } catch (cause) {
                    fail(
                      cause instanceof Error ? cause.message : 'The editor sent an invalid change.'
                    )
                    return
                  }
                  latest.current.onChangeText(mirror.current)
                } else if (message.type === 'save') {
                  if (message.session === session.current) latest.current.onSave(mirror.current)
                } else if (message.type === 'focus') {
                  if (message.session === session.current)
                    latest.current.onFocusChange(message.focused)
                } else if (message.type === 'warning') {
                  warning.current = message.message
                  latest.current.onError(message.message, false)
                } else if (message.type === 'error') fail(message.message)
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
