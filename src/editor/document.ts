export type EditorTheme = {
  background: string
  foreground: string
  muted: string
  accent: string
  selection: string
  syntax: Record<string, string>
}

export function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}
