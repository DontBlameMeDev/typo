import { type ChangeSet, Prec, StateEffect, StateField, type Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { commandCompletion, commandPrefix } from './completion'
import { isLiteralPosition } from './literal'
import type { Highlight } from './syntax'

export type GhostSuggestion = {
  pos: number
  text: string
}

const HEAD = 8_000
const TAIL = 4_000

const setGhost = StateEffect.define<GhostSuggestion | null>()

// The highlighting plugin already knows which spans are comments, strings,
// and raw text. Keep its latest ranges so a caret inside a multi-line literal
// does not need a second scan of the note.
type SyntaxSnapshot = { doc: Text; ranges: readonly Highlight[] }
const syntaxSnapshots = new WeakMap<EditorView, SyntaxSnapshot>()

export function setSyntaxRanges(view: EditorView, doc: Text, ranges: readonly Highlight[]) {
  syntaxSnapshots.set(view, { doc, ranges })
}

export function mapSyntaxRanges(view: EditorView, oldDoc: Text, doc: Text, changes: ChangeSet) {
  const snapshot = syntaxSnapshots.get(view)
  if (snapshot?.doc !== oldDoc) {
    syntaxSnapshots.delete(view)
    return
  }
  syntaxSnapshots.set(view, {
    doc,
    ranges: snapshot.ranges.map(({ from, to, style }) => ({
      from: changes.mapPos(from, 1),
      to: changes.mapPos(to, -1),
      style,
    })),
  })
}

function inLiteral(view: EditorView, pos: number): boolean {
  const snapshot = syntaxSnapshots.get(view)
  return snapshot?.doc === view.state.doc && isLiteralPosition(snapshot.ranges, pos)
}

class GhostText extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: GhostText) {
    return other.text === this.text
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ghost-text'
    span.textContent = this.text
    span.contentEditable = 'false'
    span.spellcheck = false
    span.setAttribute('aria-hidden', 'true')
    return span
  }

  // Let the editor's pointer handler see taps on the suggestion.
  ignoreEvent() {
    return false
  }
}

const ghostField = StateField.define<GhostSuggestion | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setGhost)) return effect.value
    if (!value) return null
    if (!transaction.docChanged) return transaction.selection ? null : value

    // Keep a suggestion alive while the user types the letters it predicts.
    // This is what makes a typed command feel like it snaps into place rather
    // than disappearing and requesting the same text again.
    let inserted = ''
    let from = -1
    let to = -1
    let count = 0
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
      count++
      from = fromA
      to = toA
      inserted = text.toString()
    })
    if (count !== 1 || from !== value.pos || to !== value.pos || !inserted) return null
    if (!value.text.startsWith(inserted)) return null
    const remaining = value.text.slice(inserted.length)
    if (!remaining) return null
    const selection = transaction.newSelection.main
    if (!selection.empty || selection.head !== value.pos + inserted.length) return null
    return { pos: value.pos + inserted.length, text: remaining }
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) =>
      value
        ? Decoration.set([
            Decoration.widget({ widget: new GhostText(value.text), side: 1 }).range(value.pos),
          ])
        : Decoration.none
    ),
})

function acceptGhost(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false)
  if (!ghost) return false
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects: setGhost.of(null),
    userEvent: 'input.complete',
  })
  return true
}

export function dismissGhost(view: EditorView): boolean {
  if (!view.state.field(ghostField, false)) return false
  view.plugin(ghostPlugin)?.dismiss()
  view.dispatch({ effects: setGhost.of(null) })
  return true
}

const ghostKeys = Prec.highest(
  keymap.of([
    { key: 'Tab', run: acceptGhost },
    { key: 'Escape', run: dismissGhost },
  ])
)

const ghostPointer = Prec.highest(
  EditorView.domEventHandlers({
    pointerdown(event, view) {
      if (!(event.target instanceof Element) || !event.target.closest('.cm-ghost-text'))
        return false
      event.preventDefault()
      acceptGhost(view)
      return true
    },
    touchstart(event, view) {
      if (!(event.target instanceof Element) || !event.target.closest('.cm-ghost-text'))
        return false
      event.preventDefault()
      acceptGhost(view)
      return true
    },
    mousedown(event, view) {
      if (!(event.target instanceof Element) || !event.target.closest('.cm-ghost-text'))
        return false
      event.preventDefault()
      acceptGhost(view)
      return true
    },
  })
)

const ghostPlugin = ViewPlugin.fromClass(
  class {
    private generation = 0
    private disposed = false
    private dismissed = false

    constructor(private view: EditorView) {}

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged) this.dismissed = false
      if (update.focusChanged && !update.view.hasFocus) {
        this.cancel()
        return
      }
      if (update.docChanged) {
        const ghost = update.state.field(ghostField, false)
        if (ghost && update.state.selection.main.head === ghost.pos) {
          this.cancel()
          return
        }
      }
      if (update.docChanged || update.selectionSet || update.focusChanged) this.schedule()
    }

    destroy() {
      this.disposed = true
      this.cancel()
    }

    recheck() {
      this.schedule()
    }

    dismiss() {
      this.dismissed = true
      this.cancel()
    }

    private schedule() {
      this.cancel()
      if (this.dismissed || !this.canSuggest()) return
      const generation = this.generation
      queueMicrotask(() => {
        if (this.disposed || generation !== this.generation) return
        this.show()
      })
    }

    private cancel() {
      this.generation++
    }

    private canSuggest() {
      const state = this.view.state
      return (
        this.view.hasFocus &&
        !this.view.composing &&
        !state.readOnly &&
        state.selection.ranges.length === 1 &&
        state.selection.main.empty
      )
    }

    private show() {
      if (!this.canSuggest()) return
      const state = this.view.state
      const pos = state.selection.main.head
      const line = state.doc.lineAt(pos)
      const lineBefore = state.doc.sliceString(Math.max(line.from, pos - 400), pos)
      const lineAfter = state.doc.sliceString(pos, Math.min(line.to, pos + 400))
      const text =
        inLiteral(this.view, pos) || commandPrefix(lineBefore) === null
          ? null
          : commandCompletion({ lineBefore, lineAfter, context: contextFor(state.doc, pos) })
      const current = state.field(ghostField, false)
      if (!text) {
        if (current) this.view.dispatch({ effects: setGhost.of(null) })
        return
      }
      if (current?.pos === pos && current.text === text) return
      this.view.dispatch({ effects: setGhost.of({ pos, text }) })
    }
  }
)

export function recheckGhost(view: EditorView) {
  view.plugin(ghostPlugin)?.recheck()
}

function contextFor(doc: Text, pos: number): string {
  const head = doc.sliceString(0, Math.min(pos, HEAD))
  if (pos <= HEAD) return head
  return `${head}\n${doc.sliceString(Math.max(HEAD, pos - TAIL), pos)}`
}

export function ghostText() {
  return [ghostField, ghostPlugin, ghostKeys, ghostPointer]
}
