import { expect, test } from 'bun:test'
import { runtimeDirectory } from '../src/runtime-cache'

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
