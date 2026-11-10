import { runtimeErrorScript } from '../runtime-errors'

export function pdfHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; style-src 'unsafe-inline'; font-src 'self' file: blob: data:; connect-src 'self' file:; img-src blob: data:">
<style>
:root{color-scheme:light dark;--background:#eee;--foreground:#222;--accent:#555;--surface:#313244e6}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;font-family:system-ui,sans-serif;background:var(--background);color:var(--foreground)}
body{display:flex;flex-direction:column}#scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;touch-action:pan-x pan-y;overflow-anchor:none;scrollbar-width:none}#scroll::-webkit-scrollbar{display:none}
#pages{position:relative;min-width:100%;padding:24px;display:flex;flex-direction:column;align-items:center;gap:16px}
.page{position:relative;flex-shrink:0;width:var(--page-width);height:calc(var(--page-width) * var(--page-ratio));background:white;box-shadow:0 10px 30px rgba(0,0,0,.5);--scale-factor:1;--total-scale-factor:var(--scale-factor);--scale-round-x:1px;--scale-round-y:1px}.page canvas{display:block;width:100%;height:100%}.page::after{content:attr(data-page);position:absolute;top:0;right:0;transform:translateY(-50%);height:30px;padding:0 12px;border-radius:15px;background:var(--surface);color:var(--foreground);font:600 13px system-ui,sans-serif;line-height:30px;white-space:nowrap;pointer-events:none}
.textLayer{position:absolute;inset:0;overflow:clip;line-height:1;letter-spacing:normal;word-spacing:normal;text-align:initial;text-size-adjust:none;-webkit-text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}.textLayer span,.textLayer br{position:absolute;white-space:pre;color:transparent;cursor:text;transform-origin:0% 0%;user-select:text;-webkit-user-select:text}.textLayer> :not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}.textLayer .markedContent{display:contents}.textLayer ::selection{background:transparent;color:transparent}.textLayer[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%)}.textLayer[data-main-rotation="180"]{transform:rotate(180deg) translate(-100%,-100%)}.textLayer[data-main-rotation="270"]{transform:rotate(270deg) translateX(-100%)}
.linkLayer{position:absolute;inset:0;overflow:hidden;pointer-events:none}.linkLayer a{position:absolute;pointer-events:auto;border-radius:2px;touch-action:manipulation;-webkit-tap-highlight-color:transparent}.linkLayer a:active{background:rgba(0,0,0,.12)}
#status{padding:8px;text-align:center;font-size:14px}#status:empty{display:none}
</style></head><body>
<div id="status" role="status" aria-live="polite"></div><main id="scroll" aria-label="PDF pages" tabindex="0"><div id="pages"></div></main>
<script>${runtimeErrorScript('PDF viewer')}</script><script>if(!Promise.withResolvers)Promise.withResolvers=function(){let resolve,reject;const promise=new Promise(function(ok,fail){resolve=ok;reject=fail});return{promise:promise,resolve:resolve,reject:reject}}</script><script src="pdf.bundle.js"></script>
</body></html>`
}
