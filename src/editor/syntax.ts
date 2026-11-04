import { Edit, Language, Parser, Query, type Tree } from 'web-tree-sitter'
import { typstHighlights } from './highlights'

export type Highlight = { from: number; to: number; style: string }

function point(source: string, index: number) {
  let row = 0
  let lastBreak = -1
  for (
    let next = source.indexOf('\n');
    next !== -1 && next < index;
    next = source.indexOf('\n', next + 1)
  ) {
    row++
    lastBreak = next
  }
  return { row, column: index - lastBreak - 1 }
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

export class TypstSyntax {
  private tree: Tree | null = null
  private source = ''
  private parser: Parser
  private query: Query

  constructor(language: Language) {
    this.parser = new Parser()
    this.parser.setLanguage(language)
    this.query = new Query(language, typstHighlights)
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
    const captures = this.query
      .captures(this.tree.rootNode, {
        startPosition: point(source, range.from),
        endPosition: point(source, range.to),
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
    this.query.delete()
    this.parser.delete()
  }
}

export async function typstLanguage(runtime: Uint8Array, grammar: Uint8Array) {
  // Blob workers cannot resolve the default relative WASM URL, even with wasmBinary.
  await Parser.init({ wasmBinary: runtime, locateFile: (name: string) => name })
  return Language.load(grammar)
}
