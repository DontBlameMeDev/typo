import definition from '@lumis-sh/wasm-typst/lumis.json'
import { Edit, Language, Parser, Query, type Tree } from 'web-tree-sitter'

export type Highlight = { from: number; to: number; style: string }

function point(source: string, index: number) {
  const prefix = source.slice(0, index)
  const lastBreak = prefix.lastIndexOf('\n')
  return { row: prefix.split('\n').length - 1, column: index - lastBreak - 1 }
}

export function replacementEdit(before: string, after: string) {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(before[start] || after[start] || '')) start--
  let oldEnd = before.length
  let newEnd = after.length
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  if (/[\uDC00-\uDFFF]/u.test(before[oldEnd] || after[newEnd] || '')) {
    oldEnd++
    newEnd++
  }
  return {
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: point(before, start),
    oldEndPosition: point(before, oldEnd),
    newEndPosition: point(after, newEnd),
  }
}

function captureStyle(name: string): string {
  if (name.startsWith('markup.heading')) return 'heading'
  if (name === 'markup.strong') return 'strong'
  if (name === 'markup.italic') return 'italic'
  if (name.startsWith('markup.raw')) return 'raw'
  if (name.startsWith('markup.link')) return 'link'
  if (name === 'markup.math') return 'math'
  if (name.startsWith('keyword') || name === 'boolean') return 'keyword'
  if (name.startsWith('function')) return 'function'
  if (name.startsWith('variable')) return 'variable'
  if (name.startsWith('punctuation') || name === 'operator') return 'punctuation'
  return name
}

export class TypstSyntax {
  private tree: Tree | null = null
  private source = ''
  private parser: Parser
  private query: Query

  constructor(language: Language) {
    this.parser = new Parser()
    this.parser.setLanguage(language)
    this.query = new Query(language, definition.languages.typst.highlights)
  }

  highlights(source: string, range = { from: 0, to: source.length }): Highlight[] {
    if (!this.tree || source !== this.source) {
      this.tree?.edit(new Edit(replacementEdit(this.source, source)))
      const tree = this.parser.parse(source, this.tree)
      if (!tree) throw new Error('Unable to parse this note.')
      this.tree?.delete()
      this.tree = tree
      this.source = source
    }
    if (range.from === range.to) return []
    const seen = new Set<string>()
    return this.query
      .captures(this.tree.rootNode, {
        startPosition: point(source, range.from),
        endPosition: point(source, range.to),
      })
      .flatMap(({ name, node }) => {
        const from = Math.max(range.from, node.startIndex)
        const to = Math.min(range.to, node.endIndex)
        const style = captureStyle(name)
        const key = `${from}:${to}:${style}`
        if (from >= to || seen.has(key)) return []
        seen.add(key)
        return [{ from, to, style }]
      })
  }

  destroy() {
    this.tree?.delete()
    this.query.delete()
    this.parser.delete()
  }
}

export async function typstLanguage(runtime: Uint8Array, grammar: Uint8Array) {
  await Parser.init({ wasmBinary: runtime })
  return Language.load(grammar)
}
