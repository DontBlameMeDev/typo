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
import type { EditorTheme } from './document'
import { localBytes } from './local'
import { TypstSyntax, typstLanguage } from './syntax'

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void }
    typoStart: (config: { source: string; theme: EditorTheme }) => Promise<void>
    typoEditor?: {
      setTheme: (theme: EditorTheme) => void
      setSource: (source: string) => void
      setEditable: (editable: boolean) => void
      select: (start: number, end: number) => void
      focus: () => void
      blur: () => void
    }
  }
}

const send = (message: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))

function editorTheme(theme: EditorTheme) {
  return EditorView.theme({
    '&': {
      height: '100%',
      fontSize: '14px',
      backgroundColor: theme.background,
      color: theme.foreground,
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: '"JetBrains Mono", monospace', lineHeight: '1.75' },
    '.cm-content': { padding: '16px 20px 24px', caretColor: theme.accent },
    '.cm-line': { padding: '0' },
    '.cm-cursor': { borderLeftColor: theme.accent },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: theme.selection,
    },
    ...Object.fromEntries(
      Object.entries(theme.syntax).map(([name, color]) => [`.ts-${name}`, { color }])
    ),
    '.ts-comment': { color: theme.syntax.comment, fontStyle: 'italic' },
    '.ts-heading': { color: theme.syntax.heading, fontWeight: 'bold' },
    '.ts-strong': { fontWeight: 'bold' },
    '.ts-italic': { fontStyle: 'italic' },
    '.ts-link': { color: theme.syntax.link, textDecoration: 'underline' },
  })
}

async function main(config: { source: string; theme: EditorTheme }) {
  const [runtime, grammar] = await Promise.all([
    localBytes('tree-sitter.wasm'),
    localBytes('typst-grammar.wasm'),
  ])
  const syntax = new TypstSyntax(await typstLanguage(runtime, grammar))
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
            .highlights(view.state.doc.toString())
            .map(({ from, to, style }) =>
              Decoration.mark({ class: `ts-${style}` }).range(from, to)
            ),
          true
        )
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = this.highlight(update.view)
      }
      destroy() {
        syntax.destroy()
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
  let settingSource = false
  const view = new EditorView({
    parent: document.getElementById('editor') ?? undefined,
    state: EditorState.create({
      doc: config.source,
      extensions: [
        appearance.of(editorTheme(config.theme)),
        highlighting,
        history(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'aria-label': 'Note source',
          autocapitalize: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
        }),
        editable.of([]),
        keymap.of([
          {
            key: 'Mod-s',
            run: (view) => {
              send({ type: 'save', source: view.state.doc.toString() })
              return true
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !settingSource)
            send({ type: 'change', source: update.state.doc.toString() })
        }),
      ],
    }),
  })
  window.typoEditor = {
    setTheme(theme) {
      view.dispatch({ effects: appearance.reconfigure(editorTheme(theme)) })
    },
    setSource(source) {
      if (view.state.doc.toString() === source) return
      settingSource = true
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } })
      } finally {
        settingSource = false
      }
    },
    setEditable(enabled) {
      view.dispatch({
        effects: editable.reconfigure([
          EditorState.readOnly.of(!enabled),
          EditorView.editable.of(enabled),
        ]),
      })
    },
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
