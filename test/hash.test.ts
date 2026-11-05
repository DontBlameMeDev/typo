import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { sha256 } from '../src/hash'

const reference = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

test('sha256 matches standard vectors', () => {
  expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  )
})

test('sha256 hashes UTF-8 source bytes like sha256sum', () => {
  for (const source of [
    '#title[Garden plans]\n\nWater the tomatoes on Tuesday.\n',
    '\uFEFF#title[📝 Café]\r\nÜber das Lernen.\r\n',
    '#set text(font: "Libertinus Serif")\n$ sum_(n=0)^infinity x^n $\n',
  ])
    expect(sha256(source)).toBe(reference(source))
  expect(sha256('x'.repeat(200_000))).toBe(reference('x'.repeat(200_000)))
})
