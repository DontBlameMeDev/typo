import { expect, test } from 'bun:test'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

function syntheticPdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...['First page', 'Second page'].map((text) => {
      const content = `BT /F1 24 Tf 40 700 Td (${text}) Tj ET\n`
      return `<< /Length ${content.length} >>\nstream\n${content}endstream`
    }),
  ]
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

test('PDF.js parses and prepares multiple synthetic pages using only local fonts', async () => {
  const task = getDocument({
    data: syntheticPdf(),
    standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`,
    useSystemFonts: false,
  })
  try {
    const pdf = await task.promise
    expect(pdf.numPages).toBe(2)
    for (const number of [1, 2, 1]) {
      const page = await pdf.getPage(number)
      expect(page.getViewport({ scale: 1 }).width).toBe(600)
      const text = await page.getTextContent()
      expect(text.items.map((item) => ('str' in item ? item.str : '')).join('')).toBe(
        number === 1 ? 'First page' : 'Second page'
      )
      expect((await page.getOperatorList()).fnArray.length).toBeGreaterThan(0)
      page.cleanup()
      await pdf.cleanup()
    }
  } finally {
    await task.destroy()
  }
})

test('PDF.js rejects malformed document bytes', async () => {
  const task = getDocument({ data: new TextEncoder().encode('This is not a PDF.') })
  try {
    await expect(task.promise).rejects.toThrow('Invalid PDF')
  } finally {
    await task.destroy()
  }
})

test('offline build includes the PDF worker, fonts, CMaps, image decoders, and licenses', async () => {
  await import('../scripts/build-web')
  const manifest = await Bun.file('dist/pdf-resources.txt').json()
  for (const path of [
    'cmaps/Adobe-Japan1-UCS2.bcmap',
    'standard_fonts/LiberationSans-Regular.ttf',
    'standard_fonts/FoxitSerif.pfb',
    'wasm/openjpeg.wasm',
    'wasm/jbig2.wasm',
    'wasm/qcms_bg.wasm',
    'iccs/CGATS001Compat-v2-micro.icc',
  ]) {
    expect(Buffer.from(manifest[path], 'base64').length).toBeGreaterThan(100)
  }
  for (const kind of ['pdf', 'pdf-worker']) {
    const bundle = await Bun.file(`dist/${kind}.bundle.txt`).text()
    expect(bundle.length).toBeGreaterThan(100_000)
    expect(bundle).toContain('Apache License')
  }
  expect(await Bun.file('dist/pdf-worker.bundle.txt').text()).toContain('pdfjsWorker')
}, 20_000)
