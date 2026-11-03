import { runtimeErrorScript } from '../runtime-errors'

export function pdfHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; style-src 'unsafe-inline'; font-src 'self' file: blob: data:; connect-src 'self' file:; img-src blob: data:">
<style>
:root{color-scheme:light dark;--background:#eee;--foreground:#222;--accent:#555}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;font-family:system-ui,sans-serif;background:var(--background);color:var(--foreground)}
body{display:flex;flex-direction:column}nav{display:flex;align-items:center;justify-content:center;gap:4px;padding:6px 4px;flex-shrink:0;border-bottom:1px solid var(--accent);flex-wrap:wrap}
button,input{font:inherit;color:inherit;background:transparent;border:1px solid var(--accent);border-radius:5px;min-height:40px;padding:4px 8px}button{min-width:40px;touch-action:manipulation}button:disabled{opacity:.35}input{width:55px;text-align:center}button:focus-visible,input:focus-visible{outline:2px solid var(--accent)}
#scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:12px;position:relative}canvas{display:block;background:white;margin:0 auto}canvas[hidden]{display:none}#status{padding:8px;text-align:center;font-size:14px}#status:empty{display:none}#count{white-space:nowrap;font-size:14px;padding-right:4px}
</style></head><body>
<nav aria-label="PDF controls">
<button id="previous" aria-label="Previous page" disabled>‹</button>
<input id="page" aria-label="Page number" type="number" inputmode="numeric" min="1" value="1" disabled><span id="count"></span>
<button id="next" aria-label="Next page" disabled>›</button>
<button id="out" aria-label="Zoom out" disabled>−</button><button id="fit" aria-label="Fit page width" disabled>Fit</button><button id="in" aria-label="Zoom in" disabled>+</button>
</nav><div id="status" role="status" aria-live="polite"></div><main id="scroll" aria-label="PDF page"><canvas id="canvas" hidden></canvas></main>
<script>${runtimeErrorScript('PDF viewer')}</script><script src="pdf.bundle.js"></script>
</body></html>`
}
