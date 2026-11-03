import { expect, mock, test } from 'bun:test'
import type { FileInfo } from 'expo-file-system/legacy'
import { pruneRuntimeCache, runtimeDirectory } from '../src/runtime-cache'

const root = 'file:///cache/'
const html = '<main id="pages"></main><script src="pdf.bundle.js"></script>'
const assets: [string, string][] = [
  ['pdf.bundle.js', 'viewer-v1'],
  ['pdf-worker.bundle.js', 'worker-v1'],
]

const directory = (shell = html, resources = assets) =>
  runtimeDirectory(root, 'pdf', shell, resources)

test('unchanged HTML and assets use the same offline runtime directory', () => {
  expect(directory()).toBe(
    directory(
      html,
      assets.map(([name, hash]) => [name, hash])
    )
  )
  expect(directory()).toStartWith('file:///cache/typo-runtime/pdf-')
  expect(directory()).toEndWith('/')
  expect(directory()).not.toBe('file:///cache/typo-runtime/')
})

test('a changed viewer or worker cannot reuse the previous WebView script URLs', () => {
  for (let index = 0; index < assets.length; index++) {
    const changed = assets.map(([name, hash], position): [string, string] => [
      name,
      position === index ? `${hash}-updated` : hash,
    ])
    const next = directory(html, changed)
    expect(next).not.toBe(directory())
    for (const [name] of assets) expect(`${next}${name}`).not.toBe(`${directory()}${name}`)
  }
})

test('a new page shell cannot be paired with scripts cached for the old controls', () => {
  const old = directory('<canvas id="canvas"></canvas><script src="pdf.bundle.js"></script>')
  expect(directory()).not.toBe(old)
  expect(`${directory()}pdf.bundle.js`).not.toBe(`${old}pdf.bundle.js`)
})

test('runtime kinds and resource names stay isolated', () => {
  expect(runtimeDirectory(root, 'editor', html, assets)).not.toBe(directory())
  expect(directory(html, [['different.bundle.js', assets[0][1]], assets[1]])).not.toBe(directory())
})

function cache(entries: Record<string, 'directory' | 'file' | 'missing'>) {
  const parent = `${root}typo-runtime/`
  return {
    readDirectoryAsync: mock(async (_uri: string) => Object.keys(entries)),
    getInfoAsync: mock(async (uri: string): Promise<FileInfo> => {
      const kind = entries[uri.slice(parent.length)]
      if (kind === 'missing') return { exists: false, uri, isDirectory: false }
      return {
        exists: true,
        isDirectory: kind === 'directory',
        uri,
        size: 0,
        modificationTime: 0,
      }
    }),
    deleteAsync: mock(async (_uri: string, _options?: { idempotent?: boolean }) => {}),
  }
}

test('runtime pruning removes only obsolete directories for the current kind', async () => {
  const current = directory()
  const name = current.split('/').at(-2) as string
  const files = cache({
    [name]: 'directory',
    'pdf-old': 'directory',
    'pdf-older': 'directory',
    'editor-old': 'directory',
    'compiler-old': 'directory',
    'pdf.html': 'file',
    'pdf.bundle.js': 'file',
    'pdf-worker.bundle.js': 'file',
    'pdf-missing': 'missing',
  })
  await pruneRuntimeCache(root, 'pdf', current, files)
  expect(files.readDirectoryAsync.mock.calls).toEqual([[`${root}typo-runtime/`]])
  expect(files.deleteAsync.mock.calls).toEqual([
    [`${root}typo-runtime/pdf-old`, { idempotent: true }],
    [`${root}typo-runtime/pdf-older`, { idempotent: true }],
  ])
  expect(files.getInfoAsync.mock.calls).toHaveLength(4)
})

test('runtime pruning does no metadata reads or deletes when no old versions exist', async () => {
  const name = directory().split('/').at(-2) as string
  const files = cache({ [name]: 'directory', 'compiler-old': 'directory' })
  await pruneRuntimeCache(root, 'pdf', directory(), files)
  expect(files.getInfoAsync).not.toHaveBeenCalled()
  expect(files.deleteAsync).not.toHaveBeenCalled()
})

test('runtime pruning exposes cleanup failures for the caller to handle separately', async () => {
  const files = cache({ 'pdf-old': 'directory' })
  files.deleteAsync.mockImplementation(async () => {
    throw new Error('Cache is busy')
  })
  await expect(pruneRuntimeCache(root, 'pdf', directory(), files)).rejects.toThrow('Cache is busy')
})
