export type LiteralRange = {
  from: number
  to: number
  style: string
}

export function isLiteralPosition(ranges: readonly LiteralRange[], pos: number): boolean {
  return ranges.some(
    (range) =>
      (range.style === 'comment' || range.style === 'raw' || range.style === 'string') &&
      range.from < pos &&
      range.to > pos
  )
}
