import { Prec, StateEffect, StateField, type Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { commandCompletion } from './completion'

export type GhostSuggestion = {
  pos: number
  text: string
}

const HEAD = 16_000
const TAIL = 12_000
const DELAY = 80

const setGhost = StateEffect.define<GhostSuggestion | null>()

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
    private timer: ReturnType<typeof setTimeout> | null = null

    constructor(private view: EditorView) {}

    update(update: ViewUpdate) {
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
      this.cancel()
    }

    private schedule() {
      this.cancel()
      if (!this.canSuggest()) return
      this.timer = setTimeout(() => {
        this.timer = null
        this.show()
      }, DELAY)
    }

    private cancel() {
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
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
      const text = commandCompletion({ lineBefore, context: contextFor(state.doc, pos) })
      if (!text) {
        if (state.field(ghostField, false)) this.view.dispatch({ effects: setGhost.of(null) })
        return
      }
      this.view.dispatch({ effects: setGhost.of({ pos, text }) })
    }
  }
)

function contextFor(doc: Text, pos: number): string {
  const head = doc.sliceString(0, Math.min(pos, HEAD))
  if (pos <= HEAD) return head
  return `${head}\n${doc.sliceString(Math.max(HEAD, pos - TAIL), pos)}`
}

export function ghostText() {
  return [ghostField, ghostPlugin, ghostKeys, ghostPointer]
}
