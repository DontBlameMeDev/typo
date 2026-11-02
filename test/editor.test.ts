import { beforeAll, expect, test } from 'bun:test'
import type { Language } from 'web-tree-sitter'
import { type EditorTheme, inlineJson, syntaxStyles } from '../src/editor/document'
import { editorMessage } from '../src/editor/protocol'
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

test('viewport highlighting matches full highlights and stays inside the visible range', () => {
  const syntax = new TypstSyntax(language)
  try {
    const source = '= Heading\n/* a comment\non multiple lines */\n#let emoji = "📝"\n$ x + 42 $\n'
    const all = syntax.highlights(source)
    for (const range of [
      { from: 2, to: 7 },
      { from: 23, to: 38 },
      { from: 44, to: source.length },
      { from: 0, to: 0 },
    ]) {
      const clipped = all
        .map((item) => ({
          ...item,
          from: Math.max(item.from, range.from),
          to: Math.min(item.to, range.to),
        }))
        .filter((item) => item.from < item.to)
      expect(syntax.highlights(source, range)).toEqual(clipped)
    }
    const changed = source.replace('42', '1234')
    const fresh = new TypstSyntax(language)
    try {
      const range = { from: 44, to: changed.length }
      expect(syntax.highlights(changed, range)).toEqual(fresh.highlights(changed, range))
    } finally {
      fresh.destroy()
    }
  } finally {
    syntax.destroy()
  }
})

test('syntax styles only change colors, never font metrics or wrapping', () => {
  const syntax = Object.fromEntries(
    ['heading', 'strong', 'italic', 'comment', 'string', 'keyword', 'function', 'link'].map(
      (name) => [name, '#123456']
    )
  )
  const theme: EditorTheme = {
    background: '#000000',
    foreground: '#ffffff',
    muted: '#aaaaaa',
    accent: '#123456',
    selection: '#333333',
    syntax,
  }
  for (const [name, color] of Object.entries(syntax))
    expect(syntaxStyles(theme)[`.ts-${name}`]).toEqual({ color })
})

test('replacement offsets do not split surrogate pairs', () => {
  const edit = replacementEdit('A📝B', 'A🎉B')
  expect(edit.startIndex).toBe(1)
  expect(edit.oldEndIndex).toBe(3)
  expect(edit.newEndIndex).toBe(3)
  expect(replacementEdit('one\ntwo', 'one\nthree').newEndPosition).toEqual({ row: 1, column: 5 })
})

test('a reused editor ignores changes and saves from an earlier note session', () => {
  for (const type of ['change', 'save'] as const) {
    expect(
      editorMessage(
        JSON.stringify({ type, documentId: 'note-a:1', source: 'old edit' }),
        'note-b:2'
      )
    ).toBeNull()
    expect(
      editorMessage(
        JSON.stringify({ type, documentId: 'note-a:1', source: 'discarded edit' }),
        'note-a:3'
      )
    ).toBeNull()
    expect(
      editorMessage(
        JSON.stringify({ type, documentId: 'note-a:3', source: 'current 📝' }),
        'note-a:3'
      )
    ).toEqual({ type, documentId: 'note-a:3', source: 'current 📝' })
  }
})

test('editor startup messages are independent of the document being prepared', () => {
  for (const type of ['boot', 'ready'] as const)
    expect(editorMessage(JSON.stringify({ type }), 'next-note')).toEqual({ type })
  expect(
    editorMessage(JSON.stringify({ type: 'error', message: 'Cannot load font' }), 'next-note')
  ).toEqual({ type: 'error', message: 'Cannot load font' })
  for (const value of [
    null,
    [],
    {},
    { type: 'save', source: 'no document' },
    { type: 'change', documentId: 'next-note', source: 42 },
  ])
    expect(() => editorMessage(JSON.stringify(value), 'next-note')).toThrow(
      'Invalid editor message'
    )
})

test('source and bridge data cannot terminate an inline script', () => {
  const source = '</script><script>alert("x")</script>\u2028\u2029'
  const encoded = inlineJson({ source })
  expect(encoded).not.toContain('<')
  expect(encoded).not.toContain('\u2028')
  expect(JSON.parse(encoded)).toEqual({ source })
})
