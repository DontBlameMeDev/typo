import { expect, test } from 'bun:test'
import { runtimeErrorScript } from '../src/runtime-errors'

function runtime(component = 'Source editor') {
  const listeners = new Map<string, (event: object) => void>()
  const messages: { type: string; message: string }[] = []
  const window = {
    addEventListener: (type: string, listener: (event: object) => void) =>
      listeners.set(type, listener),
    ReactNativeWebView: { postMessage: (value: string) => messages.push(JSON.parse(value)) },
  }
  new Function('window', runtimeErrorScript(component))(window)
  return {
    emit: (type: string, event: object) => listeners.get(type)?.(event),
    messages,
  }
}

test('runtime reporting does not depend on Hermes preserving function source', () => {
  const original = Function.prototype.toString
  Function.prototype.toString = () => 'function reportRuntimeErrors() { [bytecode] }'
  try {
    const { emit, messages } = runtime('PDF viewer')
    emit('error', { message: 'Startup failed' })
    expect(messages[0]?.message).toBe('PDF viewer failed.\nStartup failed')
  } finally {
    Function.prototype.toString = original
  }
})

test('script failures include the component, original error, and stack location', () => {
  const { emit, messages } = runtime()
  const error = new Error('Parser initialization failed')
  emit('error', { error })
  expect(messages[0]).toEqual({ type: 'error', message: `Source editor failed.\n${error.stack}` })
})

test('message-only failures retain script filename, line, and column', () => {
  const { emit, messages } = runtime('PDF compiler')
  emit('error', {
    message: 'Unexpected token',
    filename: 'file:///private/cache/compiler.bundle.js',
    lineno: 12,
    colno: 8,
  })
  expect(messages[0]?.message).toBe(
    'PDF compiler failed.\nUnexpected token\ncompiler.bundle.js, line 12, column 8'
  )
})

test('opaque script errors explain the missing details and give a retry step', () => {
  const { emit, messages } = runtime()
  emit('error', { message: 'Script error.' })
  expect(messages[0]?.message).toContain('Android did not provide script error details.')
  expect(messages[0]?.message).toContain('Close and reopen the note to retry.')
})

test('failed script loads identify the bundled resource', () => {
  const { emit, messages } = runtime()
  emit('error', { target: { tagName: 'SCRIPT', src: 'file:///cache/editor.bundle.js' } })
  expect(messages[0]?.message).toBe(
    'Source editor failed.\nCannot load bundled script: editor.bundle.js'
  )
})

test('unhandled async failures retain the original reason', () => {
  const { emit, messages } = runtime('PDF viewer')
  emit('unhandledrejection', { reason: new Error('Cannot decode PDF') })
  emit('unhandledrejection', { reason: 'Resource unavailable' })
  expect(messages[0]?.message).toContain('PDF viewer failed.\nError: Cannot decode PDF')
  expect(messages[1]?.message).toBe('PDF viewer failed.\nResource unavailable')
})
