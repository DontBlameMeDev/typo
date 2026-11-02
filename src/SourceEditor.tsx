import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Platform, StyleSheet, TextInput, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { inlineJson } from './editor/document'
import { useTheme } from './theme'
import { afterPaint, webRuntime } from './web-runtime'

export type SourceEditorHandle = { focus: () => void; blur: () => void }
type Props = {
  value: string
  onChangeText: (source: string) => void
  selection?: { start: number; end: number }
  editable: boolean
  onError: (message: string) => void
  onSave: (source: string) => void
}

export const SourceEditor = forwardRef<SourceEditorHandle, Props>(
  function SourceEditor(props, ref) {
    const { colors, palette } = useTheme()
    const web = useRef<WebView<object>>(null)
    const native = useRef<React.ComponentRef<typeof TextInput>>(null)
    const nativeSelection = useRef({ start: 0, end: 0 })
    const latest = useRef(props)
    latest.current = props
    const echoes = useRef(new Set<string>())
    const [uri, setUri] = useState<string | null>(null)
    const [ready, setReady] = useState(false)
    const [nativeFocused, setNativeFocused] = useState(false)
    const rich = ready && !nativeFocused
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
      focus: () => (rich ? inject('window.typoEditor?.focus()') : native.current?.focus()),
      blur: () => {
        native.current?.blur()
        inject('window.typoEditor?.blur()')
      },
    }))

    useEffect(() => {
      let cancelled = false
      const cancel = afterPaint(() => {
        void webRuntime('editor')
          .then((path) => {
            if (!cancelled) setUri(path)
          })
          .catch((cause: unknown) => {
            if (!cancelled)
              latest.current.onError(
                cause instanceof Error ? cause.message : 'Cannot load the editor.'
              )
          })
      })
      return () => {
        cancel()
        cancelled = true
      }
    }, [])

    useEffect(() => {
      if (ready && !echoes.current.delete(props.value))
        web.current?.injectJavaScript(
          `window.typoEditor?.setSource(${inlineJson(props.value)});true;`
        )
    }, [props.value, ready])
    useEffect(() => {
      if (ready) web.current?.injectJavaScript(`window.typoEditor?.setTheme(${themeJson});true;`)
    }, [themeJson, ready])
    useEffect(() => {
      if (ready)
        web.current?.injectJavaScript(
          `window.typoEditor?.setEditable(${props.editable && !nativeFocused});true;`
        )
    }, [props.editable, nativeFocused, ready])
    useEffect(() => {
      if (ready && props.selection)
        web.current?.injectJavaScript(
          `window.typoEditor?.select(${props.selection.start},${props.selection.end});true;`
        )
    }, [props.selection, ready])

    return (
      <View style={{ flex: 1, backgroundColor: colors.paper }}>
        {!rich && (
          <TextInput
            ref={native}
            accessibilityLabel="Typst source"
            value={props.value}
            onChangeText={props.onChangeText}
            editable={props.editable}
            selection={props.selection ?? (nativeFocused ? undefined : { start: 0, end: 0 })}
            onSelectionChange={(event) => {
              nativeSelection.current = event.nativeEvent.selection
            }}
            onFocus={() => setNativeFocused(true)}
            onBlur={() => {
              if (ready)
                inject(
                  `window.typoEditor?.select(${nativeSelection.current.start},${nativeSelection.current.end})`
                )
              setNativeFocused(false)
            }}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            selectionColor={colors.accent}
            style={[
              StyleSheet.absoluteFill,
              {
                color: colors.ink,
                backgroundColor: colors.paper,
                fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                fontSize: 14,
                lineHeight: 24.5,
                paddingHorizontal: 20,
                paddingTop: 16,
                paddingBottom: 24,
              },
            ]}
          />
        )}
        {uri && (
          <WebView<object>
            ref={web}
            source={{ uri }}
            style={{ flex: 1, backgroundColor: colors.paper, opacity: rich ? 1 : 0 }}
            pointerEvents={rich ? 'auto' : 'none'}
            importantForAccessibility={rich ? 'auto' : 'no-hide-descendants'}
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
                inject(`window.typoStart?.(${inlineJson({ source: latest.current.value, theme })})`)
            }}
            onError={() => {
              setReady(false)
              props.onError('The editor could not load. Your file has not been changed.')
            }}
            onRenderProcessGone={() => {
              setReady(false)
              props.onError('The editor stopped. Return to the library and reopen the note.')
            }}
            onMessage={(event) => {
              try {
                const message = JSON.parse(event.nativeEvent.data)
                if (message.type === 'boot')
                  inject(`window.typoStart(${inlineJson({ source: latest.current.value, theme })})`)
                else if (message.type === 'ready') setReady(true)
                else if (message.type === 'change' && typeof message.source === 'string') {
                  echoes.current.add(message.source)
                  if (echoes.current.size > 50)
                    echoes.current.delete(echoes.current.values().next().value ?? '')
                  latest.current.onChangeText(message.source)
                } else if (message.type === 'save' && typeof message.source === 'string')
                  latest.current.onSave(message.source)
                else if (message.type === 'error' && typeof message.message === 'string')
                  latest.current.onError(message.message)
              } catch {
                latest.current.onError('The editor sent an invalid response.')
              }
            }}
          />
        )}
      </View>
    )
  }
)
