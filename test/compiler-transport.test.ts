import { expect, test } from 'bun:test'
import type { CompileInput } from '../src/compiler/protocol'
import { CompilerTransport } from '../src/compiler/transport'

const files = [{ path: 'shared.typ', base64: 'large unchanged input' }]
const input: CompileInput = { path: 'one.typ', source: '= First', files }

test('compiler transport sends each input snapshot once across notes, edits, and package retries', () => {
  const transport = new CompilerTransport()
  expect(transport.request(input, 1, new Map()).files).toEqual(files)
  const archives = new Map([['preview/test/1.0.0', 'archive']])
  const retry = transport.request(input, 1, archives)
  expect(retry.files).toBeUndefined()
  expect(retry.archives).toEqual([{ key: 'preview/test/1.0.0', base64: 'archive' }])
  const next = transport.request({ ...input, path: 'two.typ', source: '= Second' }, 2, archives)
  expect(next.files).toBeUndefined()
  expect(next.archives).toEqual([])
  expect(next.source).toBe('= Second')
  const changed = [...files, { path: 'new.typ', base64: 'new input' }]
  const delta = transport.request({ ...input, files: changed }, 3, archives)
  expect(delta.files).toEqual([{ path: 'new.typ', base64: 'new input' }])
  expect(delta.resetFiles).toBe(false)
  const removed = transport.request({ ...input, files: [] }, 4, archives)
  expect(removed.removed).toEqual(['shared.typ', 'new.typ'])
})

test('compiler transport resends all required data after a worker restart', () => {
  const transport = new CompilerTransport()
  const archives = new Map([['preview/test/1.0.0', 'archive']])
  transport.request(input, 1, archives)
  transport.reset()
  const request = transport.request(input, 2, archives)
  expect(request.files).toEqual(files)
  expect(request.resetFiles).toBe(true)
  expect(request.archives).toHaveLength(1)
})
