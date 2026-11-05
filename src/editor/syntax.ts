import { Edit, Language, Parser, Query, type Tree } from 'web-tree-sitter'
import { typstHighlights } from './highlights'

export type Highlight = { from: number; to: number; style: string }

function points(source: string, indices: number[]) {
  const result = new Map<number, { row: number; column: number }>()
  const sorted = [...new Set(indices)].sort((a, b) => a - b)
  let row = 0
  let lastBreak = -1
  let scan = 0
  for (const index of sorted) {
    let next = source.indexOf('\n', scan)
    while (next !== -1 && next < index) {
      row++
      lastBreak = next
      scan = next + 1
      next = source.indexOf('\n', scan)
    }
    result.set(index, { row, column: index - lastBreak - 1 })
  }
  return result
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
  const beforePoints = points(before, [start, oldEnd])
  const afterPoints = points(after, [start, newEnd])
  return {
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: beforePoints.get(start) ?? { row: 0, column: 0 },
    oldEndPosition: beforePoints.get(oldEnd) ?? { row: 0, column: 0 },
    newEndPosition: afterPoints.get(newEnd) ?? { row: 0, column: 0 },
  }
}

export class TypstSyntax {
  private tree: Tree | null = null
  private source = ''
  private parser: Parser
  private query: Query

  constructor(language: Language) {
    this.parser = parserFor(language)
    this.query = queryFor(language)
  }

  highlights(source: string, range = { from: 0, to: source.length }): Highlight[] {
    if (!this.tree || source !== this.source) {
      this.tree?.edit(new Edit(replacementEdit(this.source, source)))
      // The parser reads a small chunk per line. Keep the slice bounded so large
      // notes do not copy the whole remaining source on every callback.
      const tree = this.parser.parse((index) => parseChunk(source, index), this.tree)
      if (!tree) throw new Error('Unable to parse this note.')
      this.tree?.delete()
      this.tree = tree
      this.source = source
    }
    if (range.from === range.to) return []
    const positions = points(source, [range.from, range.to])
    const captures = this.query
      .captures(this.tree.rootNode, {
        startPosition: positions.get(range.from) ?? { row: 0, column: 0 },
        endPosition: positions.get(range.to) ?? { row: 0, column: 0 },
      })
      .map(({ name, node, patternIndex }) => ({
        from: node.startIndex,
        to: node.endIndex,
        style: name,
        patternIndex,
      }))
    // Outer spans provide a base color. Inner nodes and later query patterns take precedence.
    captures.sort((a, b) => a.from - b.from || b.to - a.to || a.patternIndex - b.patternIndex)
    const result: Highlight[] = []
    const stack: Highlight[] = []
    let position = range.from
    const flush = (end: number) => {
      while (stack.length) {
        const active = stack[stack.length - 1]
        const to = Math.min(end, active.to)
        if (position < to) {
          const previous = result[result.length - 1]
          if (previous?.to === position && previous.style === active.style) previous.to = to
          else result.push({ from: position, to, style: active.style })
          position = to
        }
        if (active.to > end) break
        stack.pop()
      }
      position = end
    }
    for (const capture of captures) {
      const from = Math.max(range.from, capture.from)
      const to = Math.min(range.to, capture.to)
      if (from >= to) continue
      flush(from)
      stack.push({ from, to, style: capture.style })
    }
    flush(range.to)
    return result
  }

  destroy() {
    this.tree?.delete()
  }
}

function parseChunk(source: string, index: number) {
  const end = Math.min(index + 64, source.length)
  if (end < source.length) {
    const code = source.charCodeAt(end)
    if (code >= 0xdc00 && code <= 0xdfff) return source.slice(index, end + 1)
  }
  return source.slice(index, end)
}

const parsers = new WeakMap<Language, Parser>()
const queries = new WeakMap<Language, Query>()

function parserFor(language: Language) {
  let parser = parsers.get(language)
  if (!parser) {
    parser = new Parser()
    parser.setLanguage(language)
    parsers.set(language, parser)
  }
  return parser
}

function queryFor(language: Language) {
  let query = queries.get(language)
  if (!query) {
    query = new Query(language, typstHighlights)
    queries.set(language, query)
  }
  return query
}

export async function typstLanguage(runtime: Uint8Array, grammar: Uint8Array) {
  // Blob workers cannot resolve the default relative WASM URL, even with wasmBinary.
  await Parser.init({ wasmBinary: runtime, locateFile: (name: string) => name })
  return Language.load(grammar)
}
