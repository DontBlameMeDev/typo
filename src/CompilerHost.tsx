import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { View } from 'react-native'
import { WebView } from 'react-native-webview'
import { packageArchive } from './compiler/packages'
import {
  type CompileInput,
  type CompileResult,
  type PackageSpec,
  packageKey,
} from './compiler/protocol'
import { CompilerTransport } from './compiler/transport'
import { inlineJson } from './editor/document'
import { webRuntime } from './web-runtime'

export type CompilerHandle = { compile: (input: CompileInput) => Promise<CompileResult> }
type Job = {
  id: number
  input: CompileInput
  archives: Map<string, string>
  rounds: number
  resolve: (pdf: CompileResult) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export const CompilerHost = forwardRef<CompilerHandle>(function CompilerHost(_props, ref) {
  const web = useRef<WebView<object>>(null)
  const [uri, setUri] = useState<string | null>(null)
  const [started, setStarted] = useState(false)
  const [booted, setBooted] = useState(false)
  const [revision, setRevision] = useState(0)
  const [session, setSession] = useState(0)
  const job = useRef<Job | null>(null)
  const sequence = useRef(0)
  const transport = useRef(new CompilerTransport())
  const loadError = useRef<string | null>(null)

  const fail = useCallback((message: string) => {
    if (job.current) {
      clearTimeout(job.current.timeout)
      job.current.reject(new Error(message))
      job.current = null
    }
  }, [])
  useImperativeHandle(ref, () => ({
    compile(input) {
      if (loadError.current) return Promise.reject(new Error(loadError.current))
      if (job.current) return Promise.reject(new Error('The compiler is already running.'))
      setStarted(true)
      return new Promise<CompileResult>((resolve, reject) => {
        job.current = {
          id: ++sequence.current,
          input,
          archives: new Map(),
          rounds: 0,
          resolve,
          reject,
          timeout: setTimeout(() => {
            fail(
              'PDF generation took too long. Your source and previous PDF have not been changed.'
            )
            setBooted(false)
            setSession((value) => value + 1)
          }, 120000),
        }
        setRevision((value) => value + 1)
      })
    },
  }))
  useEffect(() => {
    if (!started) return
    let cancelled = false
    void webRuntime('compiler')
      .then((path) => {
        if (!cancelled) setUri(path)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          loadError.current = cause instanceof Error ? cause.message : 'Cannot load the compiler.'
          fail(loadError.current)
        }
      })
    return () => {
      cancelled = true
      fail('The compiler was closed.')
    }
  }, [fail, started])
  useEffect(() => {
    if (!booted || revision === 0 || !job.current) return
    const current = job.current
    web.current?.injectJavaScript(
      `window.typoCompile(${inlineJson(
        transport.current.request(current.input, current.id, current.archives)
      )});true;`
    )
  }, [booted, revision])

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
          allowFileAccessFromFileURLs
          javaScriptEnabled
          domStorageEnabled={false}
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) =>
            request.url === uri || request.url === 'about:blank'
          }
          onError={() => {
            loadError.current = 'The on-device compiler could not load.'
            fail(loadError.current)
          }}
          onRenderProcessGone={() => {
            fail('The compiler ran out of resources. Try a smaller document.')
            setBooted(false)
            setSession((value) => value + 1)
          }}
          onMessage={(event) => {
            void (async () => {
              try {
                const message = JSON.parse(event.nativeEvent.data)
                if (message.type === 'crash') {
                  fail(
                    typeof message.message === 'string' ? message.message : 'The compiler stopped.'
                  )
                  loadError.current = null
                  setBooted(false)
                  setSession((value) => value + 1)
                  return
                }
                if (message.type === 'boot') {
                  transport.current.reset()
                  setBooted(true)
                  return
                }
                if (message.type === 'error' && message.id == null) {
                  const error: string =
                    typeof message.message === 'string'
                      ? message.message
                      : 'Cannot load the compiler.'
                  loadError.current = error
                  fail(error)
                  return
                }
                const current = job.current
                if (!current || current.id !== message.id) return
                if (
                  message.type === 'pdf' &&
                  typeof message.base64 === 'string' &&
                  message.base64.startsWith('JVBERi0') &&
                  Array.isArray(message.dependencies) &&
                  message.dependencies.every((path: unknown) => typeof path === 'string')
                ) {
                  clearTimeout(current.timeout)
                  job.current = null
                  current.resolve({ base64: message.base64, dependencies: message.dependencies })
                } else if (message.type === 'error')
                  fail(
                    typeof message.message === 'string'
                      ? message.message
                      : 'Typst could not generate the PDF.'
                  )
                else if (message.type === 'packages' && Array.isArray(message.packages)) {
                  if (
                    ++current.rounds > 32 ||
                    current.archives.size + message.packages.length > 100
                  )
                    throw new Error('This document exceeds the package dependency limit.')
                  for (const spec of message.packages as PackageSpec[]) {
                    const key = packageKey(spec)
                    const archive = await packageArchive(spec)
                    if (job.current !== current) return
                    current.archives.set(key, archive)
                  }
                  if (job.current === current) setRevision((value) => value + 1)
                }
              } catch (cause) {
                fail(
                  cause instanceof Error ? cause.message : 'The compiler sent an invalid response.'
                )
              }
            })()
          }}
        />
      )}
    </View>
  )
})
