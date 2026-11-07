import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorState, StateEffect } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { type EditorTheme, syntaxStyles } from './document'
import { dismissGhost, ghostText, mapSyntaxRanges, recheckGhost, setSyntaxRanges } from './ghost'
import { HighlightQueue, type HighlightResponse } from './highlight-queue'
import { localBytes } from './local'
import type { EditorConfig } from './protocol'
import type { Highlight } from './syntax'

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void }
    typoStart: (config: EditorConfig) => Promise<void>
    typoEditor?: {
      setTheme: (theme: EditorTheme) => void
      setDocument: (documentId: string, source: string, session: number) => void
      setEditable: (editable: boolean) => void
      measure: () => void
      select: (start: number, end: number) => void
      insert: (text: string) => void
      focus: () => void
      blur: () => void
    }
  }
}

const send = (message: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))

const font = document.fonts.load('14px "JetBrains Mono"')
const syntaxAssets = Promise.all([
  localBytes('editor-worker.bundle.js'),
  localBytes('tree-sitter.wasm'),
  localBytes('typst-grammar.wasm'),
])
void font.catch(() => {})
void syntaxAssets.catch(() => {})

function editorTheme(theme: EditorTheme) {
  return EditorView.theme({
    '&': {
      height: '100%',
      fontSize: '14px',
      backgroundColor: theme.background,
      color: theme.foreground,
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: '"JetBrains Mono", monospace',
      lineHeight: '1.75',
      fontVariantLigatures: 'none',
    },
    '.cm-content': { padding: '16px 20px 24px', caretColor: theme.accent },
    '.cm-line': { padding: '0' },
    '.cm-ghost-text': {
      color: theme.muted,
      opacity: '0.55',
      textDecoration: 'underline dotted',
      textDecorationColor: theme.muted,
      textUnderlineOffset: '3px',
      userSelect: 'none',
      cursor: 'pointer',
    },
    '&:not(.cm-focused) .cm-ghost-text': { display: 'none' },
    '.cm-cursor': { borderLeftColor: theme.accent },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: theme.selection,
    },
    ...syntaxStyles(theme),
  })
}

async function main(config: EditorConfig) {
  await font
  let worker: Worker | null = null
  let workerUrl: string | null = null
  let closed = false
  const syntax = new HighlightQueue((request) => worker?.postMessage(request))
  const releaseWorkerUrl = () => {
    if (workerUrl) URL.revokeObjectURL(workerUrl)
    workerUrl = null
  }
  const syntaxFailed = (message: string) => {
    releaseWorkerUrl()
    syntax.dispose()
    worker?.terminate()
    if (!closed) send({ type: 'warning', message: `Syntax highlighting failed.\n${message}` })
  }
  void syntaxAssets
    .then(([code, runtime, grammar]) => {
      if (closed) return
      workerUrl = URL.createObjectURL(
        new Blob([code as Uint8Array<ArrayBuffer>], { type: 'text/javascript' })
      )
      worker = new Worker(workerUrl)
      worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
        if (event.data.type === 'ready') {
          releaseWorkerUrl()
          syntax.ready()
        } else if (event.data.type === 'highlights')
          syntax.complete(event.data.id, event.data.ranges)
        else if (event.data.type === 'error') syntaxFailed(event.data.message)
      }
      worker.onerror = (event) => syntaxFailed(event.message || 'The editor worker stopped.')
      worker.onmessageerror = () => syntaxFailed('The editor worker sent an invalid response.')
      worker.postMessage({ type: 'init', runtime, grammar }, [runtime.buffer, grammar.buffer])
    })
    .catch((cause: unknown) => syntaxFailed(String(cause)))
  window.addEventListener(
    'pagehide',
    () => {
      closed = true
      syntax.dispose()
      worker?.terminate()
      releaseWorkerUrl()
    },
    { once: true }
  )
  let documentId = config.documentId
  let session = config.session
  let theme = config.theme
  let enabled = config.editable
  const appearance = new Compartment()
  const editable = new Compartment()
  const highlighted = StateEffect.define<Highlight[]>()
  const highlighting = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none
      private alive = true
      constructor(view: EditorView) {
        this.highlight(view)
      }
      highlight(view: EditorView) {
        syntax.request(view.state.doc, view.viewport, (ranges) => {
          if (this.alive) view.dispatch({ effects: highlighted.of(ranges) })
        })
      }
      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes)
          mapSyntaxRanges(update.view, update.startState.doc, update.state.doc, update.changes)
        }
        for (const effect of update.transactions.flatMap((transaction) => transaction.effects)) {
          if (effect.is(highlighted)) {
            this.decorations = Decoration.set(
              effect.value.map(({ from, to, style }) =>
                Decoration.mark({ class: `ts-${style}` }).range(from, to)
              ),
              true
            )
            setSyntaxRanges(update.view, update.state.doc, effect.value)
            recheckGhost(update.view)
          }
        }
        if (update.docChanged || update.viewportChanged) this.highlight(update.view)
      }
      destroy() {
        this.alive = false
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
  let settingSource = false
  const editing = () => [EditorState.readOnly.of(!enabled), EditorView.editable.of(enabled)]
  const state = (source: string) =>
    EditorState.create({
      doc: source,
      extensions: [
        appearance.of(editorTheme(theme)),
        highlighting,
        ghostText(),
        history(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'aria-label': 'Note source',
          autocapitalize: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
        }),
        editable.of(editing()),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              send({ type: 'save', documentId, session })
              return true
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.focusChanged)
            send({ type: 'focus', documentId, session, focused: update.view.hasFocus })
          if (!update.docChanged || settingSource) return
          // Send one contiguous replacement. Multi-cursor edits keep their
          // unchanged middle, but the common single edit stays a few bytes.
          let from = -1
          let to = -1
          let newFrom = -1
          let newTo = -1
          update.changes.iterChanges((fromA, toA, fromB, toB) => {
            if (from < 0) {
              from = fromA
              newFrom = fromB
            }
            to = toA
            newTo = toB
          })
          if (from < 0) return
          send({
            type: 'change',
            documentId,
            session,
            change: { from, to, insert: update.state.doc.sliceString(newFrom, newTo) },
          })
        }),
      ],
    })
  const view = new EditorView({
    parent: document.getElementById('editor') ?? undefined,
    state: state(config.source),
  })
  // The app shrinks this view when the software keyboard opens. Keep the
  // cursor in view when that hides the line it was on.
  let visibleHeight = view.scrollDOM.clientHeight
  const resized = new ResizeObserver(() => {
    const height = view.scrollDOM.clientHeight
    if (height >= visibleHeight) {
      visibleHeight = height
      return
    }
    visibleHeight = height
    if (view.hasFocus)
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) })
  })
  resized.observe(view.scrollDOM)
  window.addEventListener('pagehide', () => resized.disconnect(), { once: true })

  // The gesture root view hands the touches of an Android back gesture to this
  // page, where they arrive as ordinary input. An inward drag from an edge is
  // that gesture: swallow it, drop the focus it may have taken, and report it as
  // Back once it is released, so an abandoned swipe never closes the note and a
  // text selection that starts near an edge is left alone.
  const BACK_ZONE = 40
  const inBackZone = (x: number) => x <= BACK_ZONE || x >= window.innerWidth - BACK_ZONE
  let backTouch: { x: number; y: number; drag: boolean; focused: boolean } | null = null
  let backSwipeAt = 0
  const stopBackTouch = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  }
  const inward = (from: number, to: number) => (from <= BACK_ZONE ? to - from > 0 : to - from < 0)
  window.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0]
      if (!touch || !inBackZone(touch.clientX)) return
      backTouch = { x: touch.clientX, y: touch.clientY, drag: false, focused: view.hasFocus }
    },
    { capture: true, passive: true }
  )
  window.addEventListener(
    'touchmove',
    (event) => {
      if (!backTouch) return
      const touch = event.touches[0]
      if (!touch) return
      const across = Math.abs(touch.clientX - backTouch.x)
      const down = Math.abs(touch.clientY - backTouch.y)
      if (!backTouch.drag && across > 8 && across > down && inward(backTouch.x, touch.clientX)) {
        backTouch.drag = true
        backSwipeAt = performance.now()
        const selection = view.state.selection.main
        if (!selection.empty) view.dispatch({ selection: { anchor: selection.head } })
      }
      if (backTouch.drag) stopBackTouch(event)
    },
    { capture: true, passive: false }
  )
  const endBackTouch = (event: TouchEvent) => {
    const touched = backTouch
    backTouch = null
    if (!touched?.drag) return
    stopBackTouch(event)
    // A swipe that came back to where it started, or that the system cancelled,
    // is not Back.
    const touch = event.changedTouches[0]
    if (event.type !== 'touchend' || !touch) return
    if (Math.abs(touch.clientX - touched.x) < 8 || !inward(touched.x, touch.clientX)) return
    // Chromium restores the focus it had when the touch began, so both the blur
    // and the report wait for the gesture to be over.
    requestAnimationFrame(() => {
      if (view.hasFocus) view.contentDOM.blur()
    })
    send({ type: 'back', editing: touched.focused })
  }
  window.addEventListener('touchend', endBackTouch, { capture: true, passive: false })
  window.addEventListener('touchcancel', endBackTouch, { capture: true, passive: false })
  // CodeMirror focuses on the click that follows a touch, which would undo the
  // blur above.
  window.addEventListener(
    'click',
    (event) => {
      if (performance.now() - backSwipeAt < 300) stopBackTouch(event)
    },
    { capture: true }
  )
  // The native side hides compile errors while the editor has focus. Report the
  // focus from the touch itself, so Back right after a tap cannot run against a
  // stale "not editing" state. A touch that never ends up focusing the editor,
  // such as a cancelled scroll, reports it back.
  let reportedFocus = false
  view.contentDOM.addEventListener(
    'pointerdown',
    (event) => {
      if (!enabled || view.hasFocus || inBackZone(event.clientX)) return
      reportedFocus = true
      send({ type: 'focus', documentId, session, focused: true })
    },
    true
  )
  const settleFocus = () => {
    if (!reportedFocus) return
    requestAnimationFrame(() => {
      if (!reportedFocus) return
      reportedFocus = false
      if (!view.hasFocus) send({ type: 'focus', documentId, session, focused: false })
    })
  }
  window.addEventListener('pointerup', settleFocus, true)
  window.addEventListener('pointercancel', settleFocus, true)
  const painted = () => {
    const id = documentId
    const paintSession = session
    view.requestMeasure({
      read: () => view.contentDOM.getBoundingClientRect(),
      write: () =>
        requestAnimationFrame(() => {
          if (id === documentId && paintSession === session)
            send({ type: 'painted', documentId: id, session })
        }),
    })
  }
  window.typoEditor = {
    setTheme(next) {
      theme = next
      view.dispatch({ effects: appearance.reconfigure(editorTheme(theme)) })
    },
    setDocument(nextId, source, nextSession) {
      session = nextSession
      if (nextId !== documentId) {
        documentId = nextId
        view.setState(state(source))
        view.scrollDOM.scrollTop = 0
        view.scrollDOM.scrollLeft = 0
        painted()
        return
      }
      if (view.state.doc.toString() === source) {
        painted()
        return
      }
      settingSource = true
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } })
      } finally {
        settingSource = false
      }
      painted()
    },
    setEditable(next) {
      enabled = next
      view.dispatch({ effects: editable.reconfigure(editing()) })
      if (!next) dismissGhost(view)
    },
    measure: painted,
    select(start, end) {
      const clamp = (index: number) => Math.max(0, Math.min(index, view.state.doc.length))
      view.dispatch({ selection: { anchor: clamp(start), head: clamp(end) }, scrollIntoView: true })
    },
    insert(text) {
      if (!enabled) return
      view.dispatch(view.state.replaceSelection(text))
      view.focus()
    },
    focus() {
      view.focus()
    },
    blur() {
      view.contentDOM.blur()
    },
  }
  send({ type: 'ready' })
  painted()
}

let started: Promise<void> | null = null
window.typoStart = (config) => {
  started ??= main(config).catch((cause: unknown) => {
    send({
      type: 'error',
      message: cause instanceof Error ? cause.message : 'Unable to start the editor.',
    })
  })
  return started
}
send({ type: 'boot' })
