import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorState } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { type EditorTheme, syntaxStyles } from './document'
import { localBytes } from './local'
import type { EditorConfig } from './protocol'
import { TypstSyntax, typstLanguage } from './syntax'

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void }
    typoStart: (config: EditorConfig) => Promise<void>
    typoEditor?: {
      setTheme: (theme: EditorTheme) => void
      setDocument: (documentId: string, source: string) => void
      setEditable: (editable: boolean) => void
      measure: () => void
      select: (start: number, end: number) => void
      focus: () => void
      blur: () => void
    }
  }
}

const send = (message: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))

const assets = Promise.all([
  Promise.all([localBytes('tree-sitter.wasm'), localBytes('typst-grammar.wasm')]).then(
    ([runtime, grammar]) => typstLanguage(runtime, grammar)
  ),
  document.fonts.load('14px "JetBrains Mono"'),
])
void assets.catch(() => {})

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
    '.cm-cursor': { borderLeftColor: theme.accent },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: theme.selection,
    },
    ...syntaxStyles(theme),
  })
}

async function main(config: EditorConfig) {
  const [language] = await assets
  const syntax = new TypstSyntax(language)
  window.addEventListener('pagehide', () => syntax.destroy(), { once: true })
  let documentId = config.documentId
  let theme = config.theme
  let enabled = config.editable
  const appearance = new Compartment()
  const editable = new Compartment()
  const highlighting = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.highlight(view)
      }
      highlight(view: EditorView) {
        return Decoration.set(
          syntax
            .highlights(view.state.doc.toString(), view.viewport)
            .map(({ from, to, style }) =>
              Decoration.mark({ class: `ts-${style}` }).range(from, to)
            ),
          true
        )
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged)
          this.decorations = this.highlight(update.view)
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
            run: (view) => {
              send({ type: 'save', documentId, source: view.state.doc.toString() })
              return true
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !settingSource)
            send({ type: 'change', documentId, source: update.state.doc.toString() })
        }),
      ],
    })
  const view = new EditorView({
    parent: document.getElementById('editor') ?? undefined,
    state: state(config.source),
  })
  const painted = () => {
    const id = documentId
    const source = view.state.doc.toString()
    view.requestMeasure({
      read: () => view.contentDOM.getBoundingClientRect(),
      write: () =>
        requestAnimationFrame(() => {
          if (id === documentId && source === view.state.doc.toString())
            send({ type: 'painted', documentId: id, source })
        }),
    })
  }
  window.typoEditor = {
    setTheme(next) {
      theme = next
      view.dispatch({ effects: appearance.reconfigure(editorTheme(theme)) })
    },
    setDocument(nextId, source) {
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
    },
    measure: painted,
    select(start, end) {
      const clamp = (index: number) => Math.max(0, Math.min(index, view.state.doc.length))
      view.dispatch({ selection: { anchor: clamp(start), head: clamp(end) }, scrollIntoView: true })
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
