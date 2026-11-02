import { beforeAll, expect, test } from 'bun:test'
import type { Language } from 'web-tree-sitter'
import { inlineJson } from '../src/editor/document'
import { replacementEdit, TypstSyntax, typstLanguage } from '../src/editor/syntax'

let language: Language
beforeAll(async () => {
  language = await typstLanguage(
    new Uint8Array(
      await Bun.file('node_modules/web-tree-sitter/web-tree-sitter.wasm').arrayBuffer()
    ),
    new Uint8Array(
      await Bun.file('node_modules/@lumis-sh/wasm-typst/tree-sitter-typst.wasm').arrayBuffer()
    )
  )
})

test('real Typst grammar highlights code, markup, and comments', () => {
  const syntax = new TypstSyntax(language)
  try {
    const source = '#let answer = 42\n#text("Hello")\n= Heading\n// A comment\n'
    const highlights = syntax.highlights(source)
    for (const style of ['keyword', 'number', 'string', 'function', 'heading', 'comment'])
      expect(highlights.some((item) => item.style === style)).toBe(true)
    expect(highlights.every((item) => item.from >= 0 && item.to <= source.length)).toBe(true)
  } finally {
    syntax.destroy()
  }
})

test('incremental edits match a fresh parse across Unicode and multiple lines', () => {
  const incremental = new TypstSyntax(language)
  const fresh = new TypstSyntax(language)
  try {
    for (const source of [
      'Über 📝\n#let x = 1',
      'Über 🎉\n#let x = 27\n= Title',
      '#text("📝")',
      '',
      '// Done\n= End',
    ]) {
      expect(incremental.highlights(source)).toEqual(fresh.highlights(source))
    }
  } finally {
    incremental.destroy()
    fresh.destroy()
  }
})

test('replacement offsets do not split surrogate pairs', () => {
  const edit = replacementEdit('A📝B', 'A🎉B')
  expect(edit.startIndex).toBe(1)
  expect(edit.oldEndIndex).toBe(3)
  expect(edit.newEndIndex).toBe(3)
  expect(replacementEdit('one\ntwo', 'one\nthree').newEndPosition).toEqual({ row: 1, column: 5 })
})

test('source and bridge data cannot terminate an inline script', () => {
  const source = '</script><script>alert("x")</script>\u2028\u2029'
  const encoded = inlineJson({ source })
  expect(encoded).not.toContain('<')
  expect(encoded).not.toContain('\u2028')
  expect(JSON.parse(encoded)).toEqual({ source })
})
