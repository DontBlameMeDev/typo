export type Diagnostic = {
  path: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'hint'
  message: string
}

const LOCATED = /^(.+):(\d+):(\d+): (error|warning|hint): (.*)$/u

export function formatDiagnostic(diagnostic: string): string {
  return diagnostic
    .replace(/^\/vault\//gmu, '')
    .replace(/^(.+):(\d+):(\d+): (error|warning|hint): /gmu, '$1, line $2, column $3\n$4: ')
    .replace(/, hints: /gu, '\nHint: ')
}

// Typst reports one location per line, and a single failure can name several
// places. Flatten them so the editor can mark the one that actually broke.
export function parseDiagnostics(diagnostics: string[]): Diagnostic[] {
  const issues: Diagnostic[] = []
  for (const diagnostic of diagnostics)
    for (const line of diagnostic.split('\n')) {
      const located = LOCATED.exec(line)
      if (!located) continue
      const [, path, row, column, severity, message] = located
      issues.push({
        path: path.startsWith('/vault/') ? path.slice('/vault/'.length) : path,
        line: Number(row),
        column: Number(column),
        severity: severity as Diagnostic['severity'],
        message: message.replace(/, hints: /u, '\nHint: '),
      })
    }
  return issues
}
