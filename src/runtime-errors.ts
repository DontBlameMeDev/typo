function reportRuntimeErrors(component: string) {
  const send = (detail: string) =>
    window.ReactNativeWebView?.postMessage(
      JSON.stringify({ type: 'error', message: `${component} failed.\n${detail}` })
    )
  const describe = (cause: unknown): string => {
    if (cause instanceof Error) return cause.stack || cause.message
    return cause == null ? 'No error details were provided.' : String(cause)
  }
  window.addEventListener(
    'error',
    (event) => {
      if (event.error) {
        send(describe(event.error))
        return
      }
      const target = event.target as HTMLScriptElement | null
      if (target?.tagName === 'SCRIPT') {
        send(`Cannot load bundled script: ${target.src.split('/').pop()}`)
        return
      }
      const location = event.filename
        ? `\n${event.filename.split('/').pop()}, line ${event.lineno}, column ${event.colno}`
        : ''
      const detail =
        !event.message || /^script error\.?$/iu.test(event.message)
          ? 'Android did not provide script error details. Close and reopen the note to retry.'
          : event.message
      send(`${detail}${location}`)
    },
    true
  )
  window.addEventListener('unhandledrejection', (event) => send(describe(event.reason)))
}

export function runtimeErrorScript(component: string): string {
  return `(${reportRuntimeErrors.toString()})(${JSON.stringify(component)})`
}
