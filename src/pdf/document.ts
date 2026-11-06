import { runtimeErrorScript } from '../runtime-errors'

export function pdfHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; style-src 'unsafe-inline'; font-src 'self' file: blob: data:; connect-src 'self' file:; img-src blob: data:">
<style>
:root{color-scheme:light dark;--background:#eee;--foreground:#222;--accent:#555}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;font-family:system-ui,sans-serif;background:var(--background);color:var(--foreground)}
body{display:flex;flex-direction:column}#scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;touch-action:pan-x pan-y;overflow-anchor:none;scrollbar-width:none}#scroll::-webkit-scrollbar{display:none}
#pages{position:relative;min-width:100%;padding:12px;display:flex;flex-direction:column;align-items:center;gap:12px}
.page{position:relative;flex-shrink:0;width:var(--page-width);height:calc(var(--page-width) * var(--page-ratio));background:white;box-shadow:0 1px 4px #0002}.page canvas{display:block;width:100%;height:100%}
#status{padding:8px;text-align:center;font-size:14px}#status:empty{display:none}
</style></head><body>
<div id="status" role="status" aria-live="polite"></div><main id="scroll" aria-label="PDF pages" tabindex="0"><div id="pages"></div></main>
<script>${runtimeErrorScript('PDF viewer')}</script><script src="pdf.bundle.js"></script>
</body></html>`
}
