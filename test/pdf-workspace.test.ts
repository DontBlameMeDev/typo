import { expect, test } from 'bun:test'
import { fingerprint, fingerprintAsync } from '../src/compiler/fingerprint'
import { type CompileInput, type CompileResult, compileFailure } from '../src/compiler/protocol'
import { type PdfRecord, PdfWorkspace } from '../src/compiler/workspace'
import { sha256 } from '../src/hash'
import type { Note } from '../src/types'

const note = (path: string, source = '= Test'): Note => ({
  uri: `content://${path}`,
  path,
  source,
  title: path,
  modifiedAt: 1,
})

function fixture() {
  const manifests = new Map<string, PdfRecord>()
  const stamps = new Map<string, string>()
  const calls: CompileInput[] = []
  const writes: string[] = []
  const hashes: string[] = []
  const published: Note[] = []
  let files: CompileInput['files'] = []
  let reads = 0
  let readError: unknown = null
  let manifestReads = 0
  let cacheError: unknown = null
  let compile = async (_input: CompileInput): Promise<CompileResult> => ({
    base64: 'JVBERi0xLjcgVGVzdA==',
    dependencies: ['style/lib.typ', 'missing.typ'],
  })
  const create = () =>
    new PdfWorkspace({
      readFiles: async () => {
        reads++
        if (readError) throw readError
        return files
      },
      compile: async (input) => {
        calls.push(input)
        return compile(input)
      },
      onPdf: (value) => published.push(value),
      storage: {
        read: async (path) => {
          manifestReads++
          const record = manifests.get(path)
          return record ? JSON.parse(JSON.stringify(record)) : null
        },
        save: async (path, record) => {
          manifests.set(path, JSON.parse(JSON.stringify(record)))
        },
        cache: async (key) => {
          if (cacheError) throw cacheError
          const uri = `file://${key}.pdf`
          stamps.set(uri, 'private')
          return uri
        },
        base64: async () => 'JVBERi0xLjcgVGVzdA==',
        stamp: async (uri) => stamps.get(uri) ?? null,
        write: async (value) => {
          writes.push(value.path)
          const uri = `content://out/${value.path}.pdf`
          stamps.set(uri, `${writes.length}`)
          return uri
        },
        hash: async (value) => {
          hashes.push(value.path)
        },
      },
    })
  return {
    create,
    calls,
    writes,
    hashes,
    published,
    manifests,
    stamps,
    files: (value: CompileInput['files']) => {
      files = value
    },
    fail: (value: unknown) => {
      readError = value
    },
    cacheFail: (value: unknown) => {
      cacheError = value
    },
    manifestReads: () => manifestReads,
    compile: (value: typeof compile) => {
      compile = value
    },
    reads: () => reads,
  }
}

async function settle(workspace: PdfWorkspace) {
  for (let index = 0; index < 500 && workspace.status.pending; index++)
    await new Promise((resolve) => setTimeout(resolve, 1))
  expect(workspace.status.pending).toBe(0)
}

async function idle(workspace: PdfWorkspace) {
  await workspace.refresh()
  for (let index = 0; index < 500 && workspace.status.pending; index++)
    await new Promise((resolve) => setTimeout(resolve, 1))
  expect(workspace.status.pending).toBe(0)
}

test('content fingerprints are deterministic, Unicode-safe, and chunk-independent', async () => {
  for (const source of ['', '= Note', 'Über 📝', 'xyz'.repeat(50000)])
    expect(await fingerprintAsync(source)).toBe(fingerprint(source))
  expect(fingerprint('abc')).not.toBe(fingerprint('xyz'))
  expect(fingerprint('ab')).not.toBe(fingerprint('abc'))
})

test('saved notes compile and persist in the library without opening their PDFs', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ'), note('nested/two.typ')])
  await idle(workspace)
  expect(f.calls.map((call) => call.path)).toEqual(['one.typ', 'nested/two.typ'])
  expect(f.writes).toEqual(['one.typ', 'nested/two.typ'])
  expect(f.published).toHaveLength(2)
  await workspace.render(note('one.typ'), '= Test')
  await idle(workspace)
  expect(f.calls).toHaveLength(2)
  expect(f.writes).toHaveLength(2)
  workspace.dispose()
})

test('autosaving one note does not re-read every compiler input', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ'), note('two.typ')])
  await idle(workspace)
  const reads = f.reads()
  workspace.setNotes([note('one.typ', '= Draft'), note('two.typ')])
  await settle(workspace)
  expect(f.reads()).toBe(reads)
  expect(f.manifests.get('one.typ')?.sourceHash).toBe(fingerprint('= Draft'))
  expect(f.manifests.get('two.typ')?.sourceHash).toBe(fingerprint('= Test'))
  workspace.dispose()
})

test('unchanged PDFs survive workspace restarts without compilation or output writes', async () => {
  const f = fixture()
  let workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  workspace.dispose()
  workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  const preview = await workspace.render(note('one.typ'), '= Test')
  expect(preview.uri).toBe(f.manifests.get('one.typ')?.uri ?? '')
  expect(f.calls).toHaveLength(1)
  expect(f.writes).toHaveLength(1)
  workspace.dispose()
})

test('dependency hashes invalidate affected notes while unrelated edits reuse cached PDFs', async () => {
  const f = fixture()
  f.files([
    { path: 'style/lib.typ', base64: 'old style' },
    { path: 'unrelated.typ', base64: 'old unrelated' },
  ])
  f.compile(async (input) => ({
    base64: 'JVBERi0x',
    dependencies: input.path === 'one.typ' ? ['style/lib.typ', 'missing.typ'] : [],
  }))
  const workspace = f.create()
  workspace.setNotes([note('one.typ'), note('two.typ')])
  await idle(workspace)
  f.files([
    { path: 'style/lib.typ', base64: 'old style' },
    { path: 'unrelated.typ', base64: 'new unrelated' },
  ])
  await idle(workspace)
  expect(f.calls).toHaveLength(2)
  expect(f.writes).toHaveLength(2)
  f.files([{ path: 'style/lib.typ', base64: 'new style' }])
  await idle(workspace)
  expect(f.calls.map((call) => call.path)).toEqual(['one.typ', 'two.typ', 'one.typ'])
  f.files([
    { path: 'style/lib.typ', base64: 'new style' },
    { path: 'missing.typ', base64: 'newly added override' },
  ])
  await idle(workspace)
  expect(f.calls).toHaveLength(4)
  workspace.dispose()
})

test('font additions and changes invalidate cached previews', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  f.files([{ path: 'fonts/custom.ttf', base64: 'font one' }])
  await idle(workspace)
  f.files([{ path: 'fonts/custom.ttf', base64: 'font two' }])
  await idle(workspace)
  expect(f.calls).toHaveLength(3)
  workspace.dispose()
})

test('missing private PDFs recompile and deleted output PDFs restore from the cache', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  f.stamps.delete('content://out/one.typ.pdf')
  await idle(workspace)
  expect(f.calls).toHaveLength(1)
  expect(f.writes).toHaveLength(2)
  f.stamps.delete(f.manifests.get('one.typ')?.uri ?? '')
  await idle(workspace)
  expect(f.calls).toHaveLength(2)
  expect(f.writes).toHaveLength(3)
  workspace.dispose()
})

test('drafts never write vault output and saving reuses the compiled draft', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  await workspace.render(note('one.typ'), '= Draft')
  expect(f.writes).toHaveLength(1)
  expect(f.manifests.get('one.typ')?.sourceHash).toBe(fingerprint('= Test'))
  workspace.setNotes([note('one.typ', '= Draft')])
  await idle(workspace)
  expect(f.calls).toHaveLength(2)
  expect(f.writes).toHaveLength(2)
  expect(f.manifests.get('one.typ')?.sourceHash).toBe(fingerprint('= Draft'))
  workspace.dispose()
})

test('failed compiles preserve previous output, suppress unchanged retries, and allow explicit retry', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  // Typst diagnostics are the only compile failures the workspace remembers.
  f.compile(async () => {
    throw compileFailure('diagnostics', 'Syntax error')
  })
  workspace.setNotes([note('one.typ', '#broken()')])
  await idle(workspace)
  expect(workspace.status.errors).toBe(1)
  expect(f.writes).toHaveLength(1)
  await expect(workspace.render(note('one.typ'), '#broken()')).rejects.toThrow('Syntax error')
  await idle(workspace)
  expect(f.calls).toHaveLength(2)
  workspace.retry('one.typ')
  await expect(workspace.render(note('one.typ'), '#broken()')).rejects.toThrow('Syntax error')
  expect(f.calls).toHaveLength(3)
  workspace.dispose()
})

test('a transient compile failure is retried by the next render without an explicit retry', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  expect(f.calls).toHaveLength(1)

  f.compile(async () => {
    throw new Error('Cannot download @preview/foo:1.0.0')
  })
  workspace.setNotes([note('one.typ', '= Edited')])
  await idle(workspace)
  expect(f.calls).toHaveLength(2)
  expect(workspace.status.errors).toBe(1)
  await expect(workspace.render(note('one.typ'), '= Edited')).rejects.toThrow('Cannot download')
  expect(f.calls).toHaveLength(3)

  f.compile(async () => ({ base64: 'JVBERi0x', dependencies: [] }))
  expect((await workspace.render(note('one.typ'), '= Edited')).source).toBe('= Edited')
  expect(f.calls).toHaveLength(4)
  expect(workspace.status.errors).toBe(0)
  workspace.dispose()
})

test('a cache write failure is not remembered as a compile failure', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  expect(f.calls).toHaveLength(1)

  f.cacheFail(new Error('No space left on device'))
  await expect(workspace.render(note('one.typ'), '= Edited')).rejects.toThrow('No space left')
  expect(f.calls).toHaveLength(2)

  f.cacheFail(null)
  expect((await workspace.render(note('one.typ'), '= Edited')).source).toBe('= Edited')
  expect(f.calls).toHaveLength(3)
  workspace.dispose()
})

test('a recorded PDF is flagged when its dependencies changed since it compiled', async () => {
  const f = fixture()
  f.files([{ path: 'style/lib.typ', base64: 'old style' }])
  f.compile(async () => ({ base64: 'JVBERi0x', dependencies: ['style/lib.typ'] }))
  let workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  workspace.dispose()

  workspace = f.create()
  await workspace.refresh()
  expect((await workspace.previous(note('one.typ')))?.stale).toBe(false)
  workspace.dispose()

  f.files([{ path: 'style/lib.typ', base64: 'new style' }])
  workspace = f.create()
  await workspace.refresh()
  const stale = await workspace.previous(note('one.typ'))
  expect(stale?.stale).toBe(true)
  expect(f.calls).toHaveLength(1)
  // Showing the recorded page must not stop the note from being recompiled.
  expect((await workspace.render(note('one.typ'), '= Test')).uri).not.toBe(stale?.uri)
  expect(f.calls).toHaveLength(2)
  workspace.dispose()
})

test('opening a note reuses the record it just read and never shows another draft', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  const previous = await workspace.previous(note('one.typ'))
  const uri = f.manifests.get('one.typ')?.uri ?? ''
  expect(previous?.uri).toBe(uri)
  const reads = f.manifestReads()
  expect((await workspace.render(note('one.typ'), '= Test')).uri).toBe(uri)
  expect(f.manifestReads()).toBe(reads)
  expect(await workspace.previous(note('one.typ', '= Draft'))).toBeNull()
  workspace.dispose()
})

test('an unchanged vault refresh keeps the previous snapshot without compiling again', async () => {
  const f = fixture()
  f.files([{ path: 'note.typ', base64: 'source' }])
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  f.files([{ path: 'note.typ', base64: 'source' }])
  await idle(workspace)
  expect(f.calls).toHaveLength(1)
  expect(f.writes).toHaveLength(1)
  workspace.dispose()
})

test('a background compile for the open note is promoted instead of repeated', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  workspace.setNotes([note('one.typ', '= Edited')])
  await workspace.render(note('one.typ'), '= Edited')
  await idle(workspace)
  expect(f.calls.map((call) => call.path)).toEqual(['one.typ', 'one.typ'])
  expect(f.manifests.get('one.typ')?.sourceHash).toBe(fingerprint('= Edited'))
  workspace.dispose()
})

test('a previous preview is available before input validation starts', async () => {
  const f = fixture()
  const original = f.create()
  original.setNotes([note('one.typ')])
  await idle(original)
  original.dispose()
  const reopened = f.create()
  expect((await reopened.previous(note('one.typ')))?.uri).toBe(f.manifests.get('one.typ')?.uri)
  expect(f.calls).toHaveLength(1)
  reopened.dispose()
})

test('a cached foreground PDF bypasses an unrelated running compile', async () => {
  const f = fixture()
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  let finish!: (result: CompileResult) => void
  const started = new Promise<void>((resolve) => {
    f.compile(
      () =>
        new Promise((done) => {
          finish = done
          resolve()
        })
    )
  })
  workspace.setNotes([note('one.typ'), note('two.typ')])
  await started
  const preview = await workspace.render(note('one.typ'), '= Test')
  expect(preview.uri).toBe(f.manifests.get('one.typ')?.uri ?? '')
  expect(f.calls).toHaveLength(2)
  finish({ base64: 'JVBERi0x', dependencies: [] })
  await idle(workspace)
  workspace.dispose()
})

test('foreground requests take priority over the library backlog and share in-flight work', async () => {
  const f = fixture()
  let finish!: (result: CompileResult) => void
  f.compile((input) =>
    input.path === 'one.typ'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve({ base64: 'JVBERi0x', dependencies: [] })
  )
  const workspace = f.create()
  workspace.setNotes([note('one.typ'), note('two.typ'), note('three.typ')])
  await workspace.refresh()
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1))
  const one = workspace.render(note('one.typ'), '= Test')
  const three = workspace.render(note('three.typ'), '= Test')
  finish({ base64: 'JVBERi0x', dependencies: [] })
  await Promise.all([one, three])
  await idle(workspace)
  expect(f.calls.map((call) => call.path)).toEqual(['one.typ', 'three.typ', 'two.typ'])
  workspace.dispose()
})

test('notes with a current vault PDF are not compiled or rewritten', async () => {
  const f = fixture()
  const workspace = f.create()
  const compiled: Note = {
    ...note('one.typ'),
    pdfUri: 'content://out/one.typ.pdf',
    pdfHash: sha256('= Test'),
  }
  const stale: Note = {
    ...note('two.typ'),
    pdfUri: 'content://out/two.typ.pdf',
    pdfHash: sha256('= Old'),
  }
  workspace.setNotes([compiled, stale])
  await idle(workspace)
  expect(f.calls.map((call) => call.path)).toEqual(['two.typ'])
  expect(f.writes).toEqual(['two.typ'])
  expect(workspace.status.errors).toBe(0)
  await workspace.render(compiled, '= Edited')
  expect(f.calls.map((call) => call.path)).toEqual(['two.typ', 'one.typ'])
  workspace.dispose()
})

test('a valid cached PDF repairs a stale vault hash without compiling', async () => {
  const f = fixture()
  let workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await idle(workspace)
  workspace.dispose()
  f.hashes.length = 0
  workspace = f.create()
  workspace.setNotes([
    {
      ...note('one.typ'),
      pdfUri: 'content://out/one.typ.pdf',
      pdfHash: sha256('= Old'),
    },
  ])
  await idle(workspace)
  expect(f.calls).toHaveLength(1)
  expect(f.hashes).toEqual(['one.typ'])
  workspace.dispose()
})

test('vault-wide input failures do not count against notes with current PDFs', async () => {
  const f = fixture()
  f.fail(new Error('Access revoked'))
  const workspace = f.create()
  workspace.setNotes([
    {
      ...note('one.typ'),
      pdfUri: 'content://out/one.typ.pdf',
      pdfHash: sha256('= Test'),
    },
  ])
  await idle(workspace)
  expect(workspace.status.errors).toBe(0)
  expect(f.calls).toHaveLength(0)
  workspace.dispose()
})

test('closing a workspace rejects queued requests and never publishes late output', async () => {
  const f = fixture()
  let finish!: (result: CompileResult) => void
  f.compile(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const workspace = f.create()
  workspace.setNotes([note('one.typ')])
  await workspace.refresh()
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1))
  const pending = workspace.render(note('one.typ'), '= Test')
  workspace.dispose()
  finish({ base64: 'JVBERi0x', dependencies: [] })
  await expect(pending).rejects.toThrow('closed')
  expect(f.writes).toEqual([])
  expect(f.published).toEqual([])
})
