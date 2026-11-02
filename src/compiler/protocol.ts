export type PackageSpec = { namespace: string; name: string; version: string }
export type CompileInput = {
  path: string
  source: string
  files: { path: string; base64: string }[]
}

export type CompileResult = { base64: string; dependencies: string[] }

export type CompileRequest = Omit<CompileInput, 'files'> & {
  files?: CompileInput['files']
  removed?: string[]
  resetFiles?: boolean
  id: number
  archives: { key: string; base64: string }[]
}

export function packageKey(spec: PackageSpec): string {
  if (
    !['preview', 'local'].includes(spec.namespace) ||
    !/^[a-z][a-z0-9-]*$/u.test(spec.name) ||
    !/^\d+\.\d+\.\d+$/u.test(spec.version)
  )
    throw new Error('The note requested an unsupported package name or version.')
  return `${spec.namespace}/${spec.name}/${spec.version}`
}

export function vaultPath(path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\\p{Cc}]/u.test(path)
  )
    throw new Error('A compiler input has an unsafe path.')
  return `/vault/${path}`
}
