import { expect, test } from 'bun:test'
import { CompilerInputs } from '../src/compiler/inputs'
import { CompilationQueue } from '../src/compiler/queue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup(run: (source: string, current: () => boolean) => Promise<string>) {
  const published: string[] = [],
    discarded: string[] = [],
    errors: unknown[] = []
  const queue = new CompilationQueue({
    run,
    async success(value: string) {
      published.push(value)
    },
    discard(value: string) {
      discarded.push(value)
    },
    error(error: unknown) {
      errors.push(error)
    },
  })
  return { queue, published, discarded, errors }
}

test('compiler input reads are shared across edits and refreshed on demand', async () => {
  const first = deferred<{ path: string; base64: string }[]>()
  let reads = 0
  const inputs = new CompilerInputs(() => {
    reads++
    return reads === 1 ? first.promise : Promise.resolve([{ path: 'new.typ', base64: 'Yg==' }])
  })
  const one = inputs.get(),
    two = inputs.get(true)
  expect(reads).toBe(1)
  first.resolve([{ path: 'note.typ', base64: 'YQ==' }])
  expect(await one).toBe(await two)
  expect(await inputs.get()).toBe(await one)
  expect(reads).toBe(1)
  expect((await inputs.get(true))[0].path).toBe('new.typ')
  expect(reads).toBe(2)
  inputs.loadedAt -= 15001
  await inputs.get()
  expect(reads).toBe(2)
  await inputs.get(true)
  expect(reads).toBe(3)
})

test('background input checks do not block compilation against the last valid snapshot', async () => {
  const refresh = deferred<{ path: string; base64: string }[]>()
  let reads = 0
  const inputs = new CompilerInputs(() =>
    ++reads === 1 ? Promise.resolve([{ path: 'old.typ', base64: 'YQ==' }]) : refresh.promise
  )
  const original = await inputs.get()
  const checking = inputs.get(true)
  expect(await inputs.get()).toBe(original)
  refresh.resolve([{ path: 'new.typ', base64: 'Yg==' }])
  await checking
  expect((await inputs.get())[0].path).toBe('new.typ')
})

test('a failed input refresh invalidates old snapshots and allows retry', async () => {
  let reads = 0
  const inputs = new CompilerInputs(async () => {
    if (++reads === 2) throw new Error('Permission denied')
    return [{ path: 'note.typ', base64: 'YQ==' }]
  })
  await inputs.get()
  await expect(inputs.get(true)).rejects.toThrow('Permission denied')
  expect(inputs.loadedAt).toBe(0)
  await inputs.get()
  expect(reads).toBe(3)
})

test('debounce coalesces edits and sharing flushes the latest buffer', async () => {
  const calls: string[] = []
  const { queue, published } = setup(async (source) => {
    calls.push(source)
    return source
  })
  queue.request('first', 1000)
  queue.request('latest', 1000)
  expect(await queue.current()).toBe('latest')
  expect(calls).toEqual(['latest'])
  expect(published).toEqual(['latest'])
  expect(await queue.current()).toBe('latest')
  expect(calls).toHaveLength(1)
  queue.dispose()
})

test('one compiler runs at a time and superseded results never publish', async () => {
  const first = deferred<string>()
  const calls: string[] = []
  let active = 0,
    maximum = 0
  const { queue, published, discarded } = setup(async (source) => {
    calls.push(source)
    maximum = Math.max(maximum, ++active)
    const result = source === 'first' ? await first.promise : source
    active--
    return result
  })
  queue.request('first')
  const waiting = queue.current()
  queue.request('second')
  queue.request('latest')
  const sharing = queue.current()
  first.resolve('old PDF')
  expect(await waiting).toBe('latest')
  expect(await sharing).toBe('latest')
  expect(calls).toEqual(['first', 'latest'])
  expect(published).toEqual(['latest'])
  expect(discarded).toEqual(['old PDF'])
  expect(maximum).toBe(1)
  queue.dispose()
})

test('an obsolete compile error does not replace a newer valid result', async () => {
  const first = deferred<string>()
  const { queue, published, errors } = setup((source) =>
    source === 'bad' ? first.promise : Promise.resolve(source)
  )
  queue.request('bad')
  const waiting = queue.current()
  queue.request('fixed')
  const latest = queue.current()
  first.reject(new Error('Old syntax error'))
  expect(await waiting).toBe('fixed')
  expect(await latest).toBe('fixed')
  expect(errors).toEqual([])
  expect(published).toEqual(['fixed'])
  queue.dispose()
})

test('current errors reject sharing instead of returning a stale PDF and can be retried', async () => {
  const { queue } = setup(async (source) => {
    if (source === 'bad') throw new Error('Syntax error')
    return source
  })
  queue.request('old')
  expect(await queue.current()).toBe('old')
  queue.request('bad')
  await expect(queue.current()).rejects.toThrow('Syntax error')
  await expect(queue.current()).rejects.toThrow('Syntax error')
  queue.request('fixed')
  expect(await queue.current()).toBe('fixed')
  queue.dispose()
})

test('edits during result persistence keep sharing waiting for the newest result', async () => {
  const writing = deferred<void>()
  const queue = new CompilationQueue({
    async run(source: string) {
      return source
    },
    async success(value: string) {
      if (value === 'first') await writing.promise
    },
    error() {},
    discard() {},
  })
  queue.request('first')
  const first = queue.current()
  await Promise.resolve()
  queue.request('latest')
  const sharing = queue.current()
  writing.resolve()
  expect(await first).toBe('latest')
  expect(await sharing).toBe('latest')
  queue.dispose()
})

test('closing before the debounce expires prevents a compilation', async () => {
  let called = false
  const { queue } = setup(async (source) => {
    called = true
    return source
  })
  queue.request('draft', 1000)
  queue.dispose()
  expect(called).toBe(false)
  expect(queue.busy).toBe(false)
  await expect(queue.current()).rejects.toThrow('closed')
})

test('closing cancels waiters and discards late results without publishing', async () => {
  const first = deferred<string>()
  const { queue, published, discarded } = setup(() => first.promise)
  queue.request('first')
  const waiting = queue.current()
  queue.dispose()
  await expect(waiting).rejects.toThrow('closed')
  first.resolve('late PDF')
  await Promise.resolve()
  await Promise.resolve()
  expect(published).toEqual([])
  expect(discarded).toEqual(['late PDF'])
  await expect(queue.current()).rejects.toThrow('closed')
})
