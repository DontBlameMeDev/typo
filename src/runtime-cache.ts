import { fingerprint } from './compiler/fingerprint'

export function runtimeDirectory(
  cacheDirectory: string,
  kind: string,
  html: string,
  resources: [string, string][]
): string {
  const version = fingerprint(JSON.stringify([html, resources]))
  return `${cacheDirectory}typo-runtime/${kind}-${version}/`
}
