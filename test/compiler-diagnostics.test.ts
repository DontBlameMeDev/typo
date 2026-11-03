import { expect, test } from 'bun:test'
import { formatDiagnostic } from '../src/compiler/diagnostics'

test('compile errors show vault-relative file, line, column, message, and hint', () => {
  expect(
    formatDiagnostic(
      '/vault/uni/notes.typ:3:2: error: unknown variable: unknown-function, hints: try adding spaces'
    )
  ).toBe(
    'uni/notes.typ, line 3, column 2\nerror: unknown variable: unknown-function\nHint: try adding spaces'
  )
})

test('warnings and package paths keep their locations', () => {
  expect(formatDiagnostic('/packages/preview/test/1.0.0/lib.typ:2:4: warning: deprecated')).toBe(
    '/packages/preview/test/1.0.0/lib.typ, line 2, column 4\nwarning: deprecated'
  )
})

test('multiline import traces retain readable locations', () => {
  expect(
    formatDiagnostic(
      '/vault/style/lib.typ:3:3: error: unknown variable\n/vault/uni/note.typ:5:2: hint: while calling heading'
    )
  ).toBe(
    'style/lib.typ, line 3, column 3\nerror: unknown variable\nuni/note.typ, line 5, column 2\nhint: while calling heading'
  )
})

test('diagnostics without a source location are preserved', () => {
  expect(formatDiagnostic('The compiler stopped.')).toBe('The compiler stopped.')
})
