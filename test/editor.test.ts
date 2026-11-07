import { beforeAll, expect, test } from 'bun:test'
import type { Language } from 'web-tree-sitter'
import { type EditorTheme, inlineJson, syntaxStyles } from '../src/editor/document'
import { applyEditorChange, editorMessage, normalizeSource } from '../src/editor/protocol'
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

function expectStyle(
  source: string,
  highlights: ReturnType<TypstSyntax['highlights']>,
  text: string,
  style: string | undefined
) {
  let from = source.indexOf(text)
  if (/^\w+$/u.test(text)) {
    while (
      from !== -1 &&
      (/[\p{L}\p{N}]$/u.test(source.slice(0, from)) ||
        /^[\p{L}\p{N}]/u.test(source.slice(from + text.length)))
    )
      from = source.indexOf(text, from + 1)
  }
  expect(from).toBeGreaterThanOrEqual(0)
  for (let index = from; index < from + text.length; index++)
    expect(highlights.find((item) => item.from <= index && item.to > index)?.style).toBe(style)
}

test('style assertions skip tokens inside supplementary Unicode identifiers', () => {
  const source = '#let 𝔸foo = 1\n#let foo𝔸 = 2\n#foo()'
  const syntax = new TypstSyntax(language)
  try {
    expectStyle(source, syntax.highlights(source), 'foo', 'function')
  } finally {
    syntax.destroy()
  }
})

test('highlights imports, content calls, table options, and markup like Typst source', () => {
  const source = `#import "style/lib.typ": *
#show: template
#title[Demo Plan]
See #link("https://example.org")[Example].
= Stage Overview
#table(
  columns: (auto, auto),
  [*Role*], [*Count*],
  [Researcher], [N/A],
)
`
  const syntax = new TypstSyntax(language)
  try {
    const highlights = syntax.highlights(source)
    for (const [text, style] of [
      ['#import', 'keyword'],
      ['"style/lib.typ"', 'string'],
      ['#show', 'keyword'],
      ['template', 'function'],
      ['#title', 'function'],
      ['#link', 'function'],
      ['"https://example.org"', 'string'],
      ['= Stage Overview', 'heading'],
      ['#table', 'function'],
      ['columns', 'property'],
      ['auto', 'keyword'],
      ['Role', 'strong'],
      ['Count', 'strong'],
      ['*', 'operator'],
    ])
      expectStyle(source, highlights, text, style)
    for (const text of ['Demo Plan', 'See ', 'Example', 'Researcher', 'N/A'])
      expectStyle(source, highlights, text, undefined)
  } finally {
    syntax.destroy()
  }
})

test('covers field calls, literals, control flow, links, escapes, and raw text', () => {
  const source = `#let double(x) = x * 2
#let data = (value: none, enabled: true, width: 12pt)
#let next = x => x + 1
#{ data.value += 1 }
#context { if not false { return data.value } else { break } }
#import "lib.typ" as lib
#data.at(0)
$ frac(a, b) + alpha_2 = x^2 $
https://example.org <demo> @demo
\\* ~
\`#literal(auto)\`
\`\`\`typst
#literal(auto)
\`\`\`
// #text("comment")
`
  const syntax = new TypstSyntax(language)
  try {
    const highlights = syntax.highlights(source)
    for (const [text, style] of [
      ['double', 'function'],
      ['value', 'property'],
      ['none', 'keyword'],
      ['true', 'keyword'],
      ['12pt', 'number'],
      ['next', 'function'],
      ['=>', 'operator'],
      ['+=', 'operator'],
      ['context', 'keyword'],
      ['if', 'keyword'],
      ['not', 'operator'],
      ['false', 'keyword'],
      ['return', 'keyword'],
      ['else', 'keyword'],
      ['break', 'keyword'],
      ['as', 'keyword'],
      ['at', 'function'],
      ['frac', 'function'],
      ['alpha', 'variable'],
      ['^', 'operator'],
      ['https://example.org', 'link'],
      ['<demo>', 'link'],
      ['@demo', 'link'],
      ['\\*', 'operator'],
      ['~', 'operator'],
      ['`#literal(auto)`', 'raw'],
      ['```typst\n#literal(auto)\n```', 'raw'],
      ['// #text("comment")', 'comment'],
    ])
      expectStyle(source, highlights, text, style)
  } finally {
    syntax.destroy()
  }
})

test('nested markup has deterministic colors without overlapping decorations', () => {
  const source = '= Title *bold _nested_* #text(fill: red)[hello] $ x + 2 $\n'
  const syntax = new TypstSyntax(language)
  try {
    const highlights = syntax.highlights(source)
    for (let index = 1; index < highlights.length; index++)
      expect(highlights[index].from).toBeGreaterThanOrEqual(highlights[index - 1].to)
    for (const [text, style] of [
      ['= Title ', 'heading'],
      ['bold ', 'strong'],
      ['nested', 'italic'],
      ['*', 'operator'],
      ['#text', 'function'],
      ['fill', 'property'],
      ['red', 'variable'],
      ['hello', 'heading'],
      ['x', 'math'],
      ['2', 'number'],
    ])
      expectStyle(source, highlights, text, style)
    // Clipping must not change which nested capture wins at a viewport boundary.
    for (let from = 0; from < source.length; from++) {
      const to = Math.min(source.length, from + 7)
      expect(syntax.highlights(source, { from, to })).toEqual(
        highlights
          .map((item) => ({ ...item, from: Math.max(from, item.from), to: Math.min(to, item.to) }))
          .filter((item) => item.from < item.to)
      )
    }
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
      '#table(columns: (auto, auto), [*Role*], [📝])',
      '#table(columns: (auto, auto), [*Role*], [📝]',
      '/* unfinished\n#text("📝")',
      '/* finished */\n#text("📝")',
      '= Title *bold _nested_* #text("📝")',
      '$ frac(alpha, 2) $',
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
    [
      'heading',
      'strong',
      'italic',
      'comment',
      'string',
      'keyword',
      'function',
      'property',
      'operator',
      'link',
    ].map((name) => [name, '#123456'])
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

test('replacement edits report rows of a CRLF note', () => {
  const edit = replacementEdit('one\r\ntwo', 'one\r\nthree')
  expect(edit.startPosition).toEqual({ row: 1, column: 1 })
  expect(edit.oldEndPosition).toEqual({ row: 1, column: 3 })
  expect(edit.newEndPosition).toEqual({ row: 1, column: 5 })
  const secondLine = replacementEdit('one\r\ntwo\nX', 'one\r\ntwo\nY')
  expect(secondLine.startPosition).toEqual({ row: 2, column: 0 })
  const appended = replacementEdit('one\r\ntwo\r\nthree', 'one\r\ntwo\r\nthree\nfour')
  expect(appended.startPosition).toEqual({ row: 2, column: 5 })
  expect(appended.newEndPosition).toEqual({ row: 3, column: 4 })
})

test('replacement edits stay exact on notes longer than one diff chunk', () => {
  const source = Array.from({ length: 600 }, (_, i) => `Line ${i} // note`).join('\n')
  const appended = replacementEdit(source, `${source}\ntail`)
  expect(appended.startPosition).toEqual({ row: 599, column: 16 })
  expect(appended.oldEndPosition).toEqual({ row: 599, column: 16 })
  expect(appended.newEndPosition).toEqual({ row: 600, column: 4 })
  const prepended = replacementEdit(source, `#${source}`)
  expect(prepended.startIndex).toBe(0)
  expect(prepended.oldEndIndex).toBe(0)
  expect(prepended.newEndIndex).toBe(1)
  expect(prepended.oldEndPosition).toEqual({ row: 0, column: 0 })
  expect(prepended.newEndPosition).toEqual({ row: 0, column: 1 })
})

test('a window deep in a long note highlights like the whole note', () => {
  for (const eol of ['\n', '\r\n']) {
    const source = Array.from({ length: 600 }, (_, i) => `#let value${i} = ${i} // A comment`).join(
      eol
    )
    const syntax = new TypstSyntax(language)
    try {
      const all = syntax.highlights(source)
      for (const range of [
        { from: 0, to: 200 },
        { from: source.length - 300, to: source.length },
        { from: Math.floor(source.length / 2), to: Math.floor(source.length / 2) + 120 },
      ])
        expect(syntax.highlights(source, range)).toEqual(
          all
            .map((item) => ({
              ...item,
              from: Math.max(range.from, item.from),
              to: Math.min(range.to, item.to),
            }))
            .filter((item) => item.from < item.to)
        )
    } finally {
      syntax.destroy()
    }
  }
})

test('a reused editor ignores changes, saves, paints, and focus from another note', () => {
  const edit = { from: 0, to: 3, insert: 'new' }
  const change = { type: 'change', documentId: 'note-a:3', session: 1, change: edit } as const
  const save = { type: 'save', documentId: 'note-a:3', session: 1 } as const
  const painted = { type: 'painted', documentId: 'note-a:3', session: 1 } as const
  const focus = { type: 'focus', documentId: 'note-a:3', session: 1, focused: true } as const
  expect(editorMessage(JSON.stringify(change), 'note-a:3')).toEqual(change)
  expect(editorMessage(JSON.stringify(save), 'note-a:3')).toEqual(save)
  expect(editorMessage(JSON.stringify(painted), 'note-a:3')).toEqual(painted)
  expect(editorMessage(JSON.stringify(focus), 'note-a:3')).toEqual(focus)
  for (const message of [change, save, painted, focus]) {
    expect(editorMessage(JSON.stringify(message), 'note-b:2')).toBeNull()
    expect(editorMessage(JSON.stringify(message), 'note-a:1')).toBeNull()
  }
})

test('normalizes line endings before applying editor offsets', () => {
  expect(normalizeSource('one\r\ntwo\rthree\n')).toBe('one\ntwo\nthree\n')
  expect(normalizeSource('one\ntwo')).toBe('one\ntwo')
  const mirror = normalizeSource('one\r\ntwo')
  expect(applyEditorChange(mirror, { from: 4, to: 4, insert: 'X' })).toBe('one\nXtwo')
})

test('editor changes replace one span and reject out-of-bounds edits', () => {
  expect(applyEditorChange('hello world', { from: 6, to: 11, insert: 'there' })).toBe('hello there')
  expect(applyEditorChange('a📝b', { from: 1, to: 3, insert: '🎉' })).toBe('a🎉b')
  expect(applyEditorChange('abc', { from: 3, to: 3, insert: '!' })).toBe('abc!')
  expect(() => applyEditorChange('abc', { from: 0, to: 4, insert: '' })).toThrow('invalid change')
  expect(() => applyEditorChange('abc', { from: 2, to: 1, insert: '' })).toThrow('invalid change')
})

test('a change carries only the edited span', () => {
  const json = JSON.stringify({
    type: 'change',
    documentId: 'note:1',
    session: 4,
    change: { from: 120_000, to: 120_001, insert: 'x' },
  })
  expect(editorMessage(json, 'note:1')).toEqual({
    type: 'change',
    documentId: 'note:1',
    session: 4,
    change: { from: 120_000, to: 120_001, insert: 'x' },
  })
})

test('editor startup messages are independent of the document being prepared', () => {
  for (const type of ['boot', 'ready'] as const)
    expect(editorMessage(JSON.stringify({ type }), 'next-note')).toEqual({ type })
  for (const editing of [true, false])
    expect(editorMessage(JSON.stringify({ type: 'back', editing }), 'next-note')).toEqual({
      type: 'back',
      editing,
    })
  expect(() => editorMessage(JSON.stringify({ type: 'back' }), 'next-note')).toThrow(
    'Invalid editor message'
  )
  for (const type of ['error', 'warning'] as const)
    expect(
      editorMessage(JSON.stringify({ type, message: 'Cannot load asset' }), 'next-note')
    ).toEqual({ type, message: 'Cannot load asset' })
  for (const value of [
    null,
    [],
    {},
    { type: 'save', source: 'no document' },
    { type: 'change', documentId: 'next-note', session: 1 },
    { type: 'change', documentId: 'next-note', session: 1, change: { from: 1, to: 0, insert: '' } },
    { type: 'painted', documentId: 'next-note' },
    { type: 'painted', documentId: 2, session: 1 },
    { type: 'painted', documentId: 'next-note', session: null },
    { type: 'focus', documentId: 'next-note', session: 1 },
    { type: 'focus', documentId: 'next-note', session: 1, focused: 'yes' },
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
