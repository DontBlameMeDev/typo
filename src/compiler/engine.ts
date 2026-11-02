import init, { type ProxyContext, TypstCompilerBuilder } from '@myriaddreamin/typst-ts-web-compiler'

import { type PackageSpec, packageKey, vaultPath } from './protocol'

export type CompileOutput = {
  pdf?: Uint8Array
  diagnostics: string[]
  missing: PackageSpec[]
  dependencies: string[]
}

export async function initializeCompiler(wasm: Uint8Array) {
  await init({ module_or_path: wasm as Uint8Array<ArrayBuffer> })
}

export async function createCompiler(
  files: Map<string, Uint8Array>,
  fonts: Uint8Array[],
  archives: Map<string, Uint8Array>
) {
  const missing = new Map<string, PackageSpec>()
  const dependencies = new Set<string>()
  const track = (name: string) => {
    if (name.startsWith('/vault/')) dependencies.add(name.slice('/vault/'.length))
    return name
  }
  let total = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0)
  const canonical = (name: string): string => {
    track(name)
    if (files.has(name)) return name
    for (const shared of ['style/', 'assets/', 'bibliography.yml']) {
      const index = name.indexOf(`/${shared}`, '/vault/'.length)
      if (name.startsWith('/vault/') && index >= 0) {
        const root = track(`/vault${name.slice(index)}`)
        if (files.has(root)) return root
      }
    }
    return name
  }
  const builder = new TypstCompilerBuilder()
  let built = false
  try {
    await builder.set_access_model(
      files,
      () => Date.now(),
      (name: string) => files.has(canonical(name)),
      canonical,
      (name: string) => files.get(canonical(name))
    )
    await builder.set_package_registry(files, function (this: ProxyContext, spec: PackageSpec) {
      const key = packageKey(spec)
      const portable = `/vault/packages/${key}`
      if (files.has(track(`${portable}/typst.toml`))) return portable
      const archive = archives.get(key)
      if (!archive) {
        missing.set(key, spec)
        return undefined
      }
      const root = `/packages/${key}`
      if (files.has(`${root}/typst.toml`)) return root
      this.untar(archive, (name: string, bytes: Uint8Array) => {
        const relative = name.replace(/^(\.\/)+/u, '')
        if (
          !relative ||
          relative.startsWith('/') ||
          relative.split('/').some((part) => part === '..') ||
          /[\\\p{Cc}]/u.test(relative)
        )
          throw new Error('A package contains an unsafe file path.')
        total += bytes.length
        if (total > 100 * 1024 * 1024 || files.size >= 10000)
          throw new Error('Compiler dependencies exceed the 100 MiB limit.')
        files.set(`${root}/${relative}`, bytes)
      })
      return root
    })
    for (const font of fonts) await builder.add_raw_font(font)
    const compiler = await builder.build()
    built = true
    return {
      compile(path: string): CompileOutput {
        missing.clear()
        dependencies.clear()
        // Keep the font database and package files, but invalidate previous source reads.
        compiler.reset()
        const world = compiler.snapshot('/vault', vaultPath(path), [])
        try {
          const result = world.get_artifact(1, 2) as { result?: Uint8Array; diagnostics?: string[] }
          return {
            pdf: result.result,
            diagnostics: result.diagnostics ?? [],
            missing: [...missing.values()],
            dependencies: [...dependencies],
          }
        } catch (cause) {
          return {
            diagnostics: [cause instanceof Error ? cause.message : String(cause)],
            missing: [...missing.values()],
            dependencies: [...dependencies],
          }
        } finally {
          world.free()
        }
      },
      dispose: () => compiler.free(),
    }
  } finally {
    if (!built) builder.free()
  }
}

export async function compilePdf(
  path: string,
  input: Map<string, Uint8Array>,
  fonts: Uint8Array[],
  archives: Map<string, Uint8Array>
): Promise<CompileOutput> {
  const compiler = await createCompiler(new Map(input), fonts, archives)
  try {
    return compiler.compile(path)
  } finally {
    compiler.dispose()
  }
}
