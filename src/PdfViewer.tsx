import * as FileSystem from 'expo-file-system/legacy'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'
import { WebView } from 'react-native-webview'
import { inlineJson } from './editor/document'
import { useTheme } from './theme'
import { afterPaint, webRuntime } from './web-runtime'

const SPINNER_DELAY = 120

type Props = {
  source: { uri: string } | null
  style?: StyleProp<ViewStyle>
  onError: (cause: Error) => void
}

export default function PdfViewer(props: Props) {
  const { colors } = useTheme()
  const web = useRef<WebView<object>>(null)
  const latest = useRef(props)
  latest.current = props
  const [uri, setUri] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [displayed, setDisplayed] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const requested = useRef<string | null>(null)
  const theme = inlineJson({
    background: colors.soft,
    foreground: colors.ink,
    accent: colors.accent,
    scrollbar: colors.muted,
  })
  const source = props.source?.uri ?? null
  const showing = !!source && displayed === source

  useEffect(() => {
    let canceled = false
    const cancel = afterPaint(() => {
      void webRuntime('pdf')
        .then((path) => {
          if (!canceled) setUri(path)
        })
        .catch((cause: unknown) => {
          if (!canceled)
            latest.current.onError(
              cause instanceof Error ? cause : new Error('Cannot load the offline PDF viewer.')
            )
        })
    })
    return () => {
      cancel()
      canceled = true
    }
  }, [])

  useEffect(() => {
    if (ready) return
    const timer = setTimeout(
      () => latest.current.onError(new Error('The offline PDF viewer took too long to start.')),
      30_000
    )
    return () => clearTimeout(timer)
  }, [ready])

  useEffect(() => {
    if (showing) {
      setWaiting(false)
      return
    }
    const timer = setTimeout(() => setWaiting(true), SPINNER_DELAY)
    return () => clearTimeout(timer)
  }, [showing])

  useEffect(() => {
    if (!ready || !source || showing) return
    const timer = setTimeout(
      () =>
        latest.current.onError(
          new Error('The PDF viewer did not display any pages. Try reopening the PDF.')
        ),
      60_000
    )
    return () => clearTimeout(timer)
  }, [ready, source, showing])

  useEffect(() => {
    if (ready) web.current?.injectJavaScript(`window.typoPdf?.theme(${theme});true;`)
  }, [ready, theme])

  useEffect(() => {
    if (!ready || !source || requested.current === source) return
    requested.current = source
    setDisplayed(null)
    web.current?.injectJavaScript(`window.typoPdf?.load(${inlineJson(source)});true;`)
  }, [ready, source])

  return (
    <View style={[{ flex: 1, backgroundColor: colors.soft }, props.style]}>
      {uri && (
        <WebView<object>
          ref={web}
          source={{ uri }}
          style={{ flex: 1, backgroundColor: colors.soft, opacity: source && !showing ? 0 : 1 }}
          originWhitelist={['file://*']}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowingReadAccessToURL={FileSystem.cacheDirectory ?? undefined}
          javaScriptEnabled
          setBuiltInZoomControls={false}
          setDisplayZoomControls={false}
          domStorageEnabled={false}
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) =>
            request.url === uri || request.url === 'about:blank'
          }
          onError={() => props.onError(new Error('The offline PDF viewer could not load.'))}
          onRenderProcessGone={() =>
            props.onError(new Error('The PDF viewer stopped. Try reopening the PDF.'))
          }
          onContentProcessDidTerminate={() =>
            props.onError(new Error('The PDF viewer stopped. Try reopening the PDF.'))
          }
          onMessage={(event) => {
            try {
              const message = JSON.parse(event.nativeEvent.data)
              if (message.type === 'boot') {
                const target = latest.current.source?.uri ?? null
                requested.current = target
                setDisplayed(null)
                if (target)
                  web.current?.injectJavaScript(
                    `window.typoPdf.theme(${theme});window.typoPdf.load(${inlineJson(target)});true;`
                  )
                setReady(true)
              } else if (
                message.type === 'rendered' &&
                message.uri === (latest.current.source?.uri ?? requested.current)
              )
                setDisplayed(message.uri)
              else if (message.type === 'error' && typeof message.message === 'string')
                latest.current.onError(new Error(message.message))
            } catch {
              latest.current.onError(new Error('The PDF viewer sent an invalid response.'))
            }
          }}
        />
      )}
      {!showing && waiting && (
        <View style={[s.loading, { backgroundColor: colors.soft }]}>
          <ActivityIndicator size="small" color={colors.muted} />
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  loading: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
