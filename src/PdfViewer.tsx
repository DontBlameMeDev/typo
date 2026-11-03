import * as FileSystem from 'expo-file-system/legacy'
import { useEffect, useRef, useState } from 'react'
import { type StyleProp, View, type ViewStyle } from 'react-native'
import { WebView } from 'react-native-webview'
import { inlineJson } from './editor/document'
import { useTheme } from './theme'
import { afterPaint, webRuntime } from './web-runtime'

type Props = {
  source: { uri: string }
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
  const theme = inlineJson({
    background: colors.soft,
    foreground: colors.ink,
    accent: colors.accent,
  })
  const inject = (script: string) => web.current?.injectJavaScript(`${script};true;`)

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
    if (!ready || displayed === props.source.uri) return
    const timer = setTimeout(
      () =>
        latest.current.onError(
          new Error('The PDF viewer did not display any pages. Try reopening the PDF.')
        ),
      60_000
    )
    return () => clearTimeout(timer)
  }, [ready, displayed, props.source.uri])

  useEffect(() => {
    if (ready) web.current?.injectJavaScript(`window.typoPdf?.theme(${theme});true;`)
  }, [ready, theme])

  useEffect(() => {
    if (ready)
      web.current?.injectJavaScript(`window.typoPdf?.load(${inlineJson(props.source.uri)});true;`)
  }, [ready, props.source.uri])

  return (
    <View style={[{ flex: 1, backgroundColor: colors.soft }, props.style]}>
      {uri && (
        <WebView<object>
          ref={web}
          source={{ uri }}
          style={{ flex: 1, backgroundColor: colors.soft, opacity: ready ? 1 : 0 }}
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
                inject(
                  `window.typoPdf.theme(${theme});window.typoPdf.load(${inlineJson(latest.current.source.uri)})`
                )
                setReady(true)
              } else if (message.type === 'rendered' && typeof message.uri === 'string')
                setDisplayed(message.uri)
              else if (message.type === 'error' && typeof message.message === 'string')
                latest.current.onError(new Error(message.message))
            } catch {
              latest.current.onError(new Error('The PDF viewer sent an invalid response.'))
            }
          }}
        />
      )}
    </View>
  )
}
