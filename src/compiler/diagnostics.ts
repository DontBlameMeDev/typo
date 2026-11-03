export function formatDiagnostic(diagnostic: string): string {
  return diagnostic
    .replace(/^\/vault\//gmu, '')
    .replace(/^(.+):(\d+):(\d+): (error|warning|hint): /gmu, '$1, line $2, column $3\n$4: ')
    .replace(/, hints: /gu, '\nHint: ')
}
