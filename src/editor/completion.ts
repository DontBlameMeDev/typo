// Small, local command completions for Typst source. The editor only asks for a
// suggestion after a short pause, so this can afford to look at a bounded slice
// of the note without touching the document on every keystroke.

export type CompletionInput = {
  // The current line up to the caret, bounded by the caller.
  lineBefore: string
  // A bounded slice of the note used to rank commands already in use.
  context: string
}

type SymbolStat = {
  count: number
  last: number
  defined: boolean
}

// Typo's template convention comes first so a bare `#` has a useful default.
// Keep this list short: the note's own symbols always rank above these.
const commands = [
  'title',
  'text',
  'set',
  'show',
  'let',
  'import',
  'include',
  'figure',
  'image',
  'table',
  'grid',
  'link',
  'emph',
  'strong',
  'quote',
  'raw',
  'heading',
  'outline',
  'bibliography',
  'cite',
  'ref',
  'label',
  'align',
  'columns',
  'stack',
  'box',
  'block',
  'place',
  'pad',
  'par',
  'list',
  'enum',
  'terms',
  'math',
  'context',
  'if',
  'else',
  'for',
  'while',
  'return',
  'break',
  'continue',
  'pagebreak',
  'linebreak',
  'page',
  'sym',
  'counter',
  'state',
  'query',
  'metadata',
  'datetime',
  'duration',
  'decimal',
  'rgb',
  'luma',
  'cmyk',
  'stroke',
  'measure',
  'layout',
  'style',
  'select',
  'regex',
  'str',
  'int',
  'float',
  'array',
  'dictionary',
  'type',
  'repr',
  'panic',
  'assert',
  'eval',
  'read',
  'json',
  'csv',
  'yaml',
  'toml',
  'xml',
  'bytes',
  'range',
  'calc',
  'upper',
  'lower',
  'to-uppercase',
  'to-lowercase',
  'none',
  'auto',
  'true',
  'false',
] as const

const commandRank = new Map(commands.map((name, index) => [name, commands.length - index]))

const commandName = /[\p{L}_][\p{L}\p{N}_-]*/gu
const letFunction = /#let\s+([\p{L}_][\p{L}\p{N}_-]*)\s*\(/gu
const letValue = /#let\s+([\p{L}_][\p{L}\p{N}_-]*)\s*=/gu
const importNames = /#import\s+(?:"[^"\n]*"|[^\s:]+)\s*:\s*([^\n]+)/gu
const importAlias = /#import\s+(?:"[^"\n]*"|[^\s:]+)\s+as\s+([\p{L}_][\p{L}\p{N}_-]*)/gu
const identifier = /^[\p{L}_][\p{L}\p{N}_-]*$/u
const trailingCommand = /#([\p{L}_][\p{L}\p{N}_-]*)?$/u
const asAlias = /\bas\s+([\p{L}_][\p{L}\p{N}_-]*)\s*$/u
const leadingName = /^[\p{L}_][\p{L}\p{N}_-]*/u

export function commandCompletion({ lineBefore, context }: CompletionInput): string | null {
  const start = commandStart(lineBefore)
  if (start < 0) return null
  const prefix = lineBefore.slice(start + 1)
  const symbols = localSymbols(context)
  const candidates = new Map<string, number>()

  for (const [name, stat] of symbols)
    candidates.set(
      name,
      1000 + stat.count * 10 + (stat.defined ? 40 : 0) + Math.min(stat.last, 100_000) / 100_000
    )
  for (const name of commands)
    if (!candidates.has(name)) candidates.set(name, commandRank.get(name) ?? 0)

  let best: { name: string; score: number } | null = null
  for (const [name, score] of candidates) {
    if (name.length <= prefix.length) continue
    if (prefix && !name.startsWith(prefix)) continue
    if (!best || score > best.score || (score === best.score && name.length < best.name.length))
      best = { name, score }
  }
  return best ? best.name.slice(prefix.length) : null
}

export function commandPrefix(lineBefore: string): string | null {
  const start = commandStart(lineBefore)
  return start < 0 ? null : lineBefore.slice(start + 1)
}

export function localSymbols(source: string): Map<string, SymbolStat> {
  const symbols = new Map<string, SymbolStat>()
  // Strings, raw text, and comments can contain a literal #. Removing them
  // keeps ranking focused on actual code without needing the syntax tree.
  const code = source
    .replace(/"(?:\\.|[^"\\])*"/gu, '""')
    .replace(/`{1,3}[\s\S]*?`{1,3}/gu, '``')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '')

  for (const match of code.matchAll(commandName)) {
    const before = match.index ? code[match.index - 1] : ''
    if (before !== '#') continue
    addSymbol(symbols, match[0], match.index ?? 0)
  }
  for (const match of code.matchAll(letFunction))
    addSymbol(symbols, match[1], match.index ?? 0, true, 4)
  for (const match of code.matchAll(letValue))
    addSymbol(symbols, match[1], match.index ?? 0, false, 1)
  for (const match of code.matchAll(importNames)) {
    const index = match.index ?? 0
    for (const part of match[1].split(',')) {
      const alias = asAlias.exec(part)
      const name = alias ? alias[1] : leadingName.exec(part.trim())?.[0]
      if (name) addSymbol(symbols, name, index, true, 3)
    }
  }
  for (const match of code.matchAll(importAlias))
    addSymbol(symbols, match[1], match.index ?? 0, true, 3)
  return symbols
}

function addSymbol(
  symbols: Map<string, SymbolStat>,
  name: string,
  index: number,
  defined = false,
  weight = 1
) {
  if (!identifier.test(name)) return
  const stat = symbols.get(name)
  if (stat) {
    stat.count += weight
    stat.last = Math.max(stat.last, index)
    stat.defined ||= defined
  } else symbols.set(name, { count: weight, last: index, defined })
}

function commandStart(line: string): number {
  const match = trailingCommand.exec(line)
  if (!match || match.index === undefined) return -1
  const start = match.index
  if (line[start - 1] === '#' || isEscaped(line, start) || inLiteral(line, start)) return -1
  return start
}

function isEscaped(line: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor--) slashes++
  return slashes % 2 === 1
}

function inLiteral(line: string, index: number): boolean {
  let quoted = false
  let raw = false
  let block = false
  for (let cursor = 0; cursor < index; cursor++) {
    const character = line[cursor]
    if (character === '\\') {
      cursor++
      continue
    }
    if (quoted) {
      if (character === '"') quoted = false
      continue
    }
    if (raw) {
      if (character === '`') raw = false
      continue
    }
    if (block) {
      if (character === '*' && line[cursor + 1] === '/') {
        block = false
        cursor++
      }
      continue
    }
    if (character === '"') quoted = true
    else if (character === '`') raw = true
    else if (character === '/' && line[cursor + 1] === '*') {
      block = true
      cursor++
    } else if (character === '/' && line[cursor + 1] === '/' && line[cursor - 1] !== ':')
      return true
  }
  return quoted || raw || block
}
