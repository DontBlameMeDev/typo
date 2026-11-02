const packages = [
  '@codemirror/commands',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@marijn/find-cluster-break',
  'style-mod',
  'w3c-keyname',
  'crelt',
  'web-tree-sitter',
  '@lumis-sh/wasm-typst',
]
const notices = await Promise.all([
  ...packages.map((name) => Bun.file(`node_modules/${name}/LICENSE`).text()),
  Bun.file('assets/licenses/tree-sitter-typst.txt').text(),
  Bun.file('assets/licenses/typst-ts.txt').text(),
  Bun.file('assets/fonts/OFL.txt').text(),
  Bun.file('assets/fonts/typst/LICENSE.txt').text(),
  Bun.file('assets/fonts/typst/NOTICE.txt').text(),
])
for (const kind of ['editor', 'compiler', 'compiler-worker']) {
  const result = await Bun.build({
    entrypoints: [kind === 'compiler-worker' ? 'src/compiler/worker.ts' : `src/${kind}/web.ts`],
    target: 'browser',
    format: 'iife',
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.url': 'globalThis.location.href',
    },
    external: ['fs', 'fs/promises', 'module'],
  })
  if (!result.success) throw new AggregateError(result.logs, `Cannot bundle ${kind}.`)
  const text = await result.outputs[0].text()
  await Bun.write(
    `dist/${kind}.bundle.txt`,
    `${text}\n/*!\n${notices.join('\n\n').replaceAll('*/', '* /')}\n*/\n`
  )
}
console.log('Bundled the offline editor and Typst compiler.')
