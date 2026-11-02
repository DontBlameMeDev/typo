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
const pdfNotices = [await Bun.file('node_modules/pdfjs-dist/LICENSE').text()]
const pdfResources: Record<string, string> = {}
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const glob = new Bun.Glob('*')
  const cwd = `node_modules/pdfjs-dist/${folder}`
  for (const name of [...glob.scanSync({ cwd })].sort()) {
    const file = Bun.file(`${cwd}/${name}`)
    if (name.startsWith('LICENSE')) pdfNotices.push(await file.text())
    else
      pdfResources[`${folder}/${name}`] = Buffer.from(await file.arrayBuffer()).toString('base64')
  }
}
await Bun.write('dist/pdf-resources.txt', JSON.stringify(pdfResources))
for (const kind of ['editor', 'compiler', 'compiler-worker', 'pdf', 'pdf-worker']) {
  const result = await Bun.build({
    entrypoints: [
      kind.endsWith('-worker')
        ? `src/${kind.replace('-worker', '')}/worker.ts`
        : `src/${kind}/web.ts`,
    ],
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
    `${text}\n/*!\n${(kind.startsWith('pdf') ? pdfNotices : notices).join('\n\n').replaceAll('*/', '* /')}\n*/\n`
  )
}
console.log('Bundled the offline editor, Typst compiler, and PDF.js viewer.')
