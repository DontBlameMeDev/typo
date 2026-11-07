import { type Range, StateEffect, StateField, type Text } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import type { EditorTheme } from './document'

export type EditorIssue = {
  line: number | null
  column: number | null
  severity: 'error' | 'warning' | 'hint'
  message: string
  // Set only when the location belongs to another file than the open note.
  path?: string
}

type IssueState = { issues: EditorIssue[]; decorations: DecorationSet }

// A new editor state starts from the latest compile result. The native side
// sets this before the boot payload creates the state.
let seeded: EditorIssue[] = []
let popup: HTMLDivElement | null = null
let popupTheme: EditorTheme | null = null

const HIT_X = 16
const HIT_Y = 10
const setIssues = StateEffect.define<EditorIssue[]>()
const FLASH_MS = 1600
const setFlash = StateEffect.define<{ from: number; to: number } | null>()

function position(doc: Text, issue: EditorIssue): number | null {
  if (!issue.line) return null
  const line = doc.line(Math.max(1, Math.min(issue.line, doc.lines)))
  return line.from + Math.max(0, Math.min((issue.column ?? 1) - 1, line.length))
}

// Underline the token the compiler pointed at, not the whole line.
function issueRange(doc: Text, issue: EditorIssue): { from: number; to: number } | null {
  if (issue.path || issue.severity !== 'error') return null
  const from = position(doc, issue)
  if (from === null) return null
  const line = doc.lineAt(from)
  // A location on the line break has no glyph to underline, so mark the last
  // character of the line instead.
  const start = from === line.to && line.from < line.to ? from - 1 : from
  const word = /^[\p{L}\p{N}_-]+/u.exec(doc.sliceString(start, line.to))?.[0] ?? ''
  const end = Math.min(line.to, start + Math.max(1, word.length))
  return start < end ? { from: start, to: end } : null
}

function decorations(doc: Text, issues: EditorIssue[]): DecorationSet {
  const ranges: Range<Decoration>[] = []
  issues.forEach((issue, index) => {
    const range = issueRange(doc, issue)
    if (!range) return
    ranges.push(
      Decoration.mark({
        class: 'cm-issue',
        attributes: { 'data-issue': String(index) },
      }).range(range.from, range.to)
    )
  })
  return Decoration.set(ranges, true)
}

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setFlash))
        return effect.value
          ? Decoration.set([
              Decoration.mark({ class: 'cm-issue-flash' }).range(
                effect.value.from,
                effect.value.to
              ),
            ])
          : Decoration.none
    return transaction.docChanged ? value.map(transaction.changes) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

const issueField = StateField.define<IssueState>({
  create: (state) => ({ issues: seeded, decorations: decorations(state.doc, seeded) }),
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setIssues))
        return {
          issues: effect.value,
          decorations: decorations(transaction.state.doc, effect.value),
        }
    if (!transaction.docChanged) return value
    return { issues: value.issues, decorations: value.decorations.map(transaction.changes) }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

function createPopup() {
  const element = document.createElement('div')
  element.className = 'typo-issue-popup'
  element.hidden = true
  element.setAttribute('role', 'status')
  element.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'z-index:20',
    'box-sizing:border-box',
    'max-height:50vh',
    'overflow:hidden',
    'padding:8px 10px',
    'border:1px solid transparent',
    'border-radius:8px',
    'font:12px/1.5 "JetBrains Mono", monospace',
    'white-space:pre-wrap',
    'overflow-wrap:anywhere',
    'pointer-events:none',
    'box-shadow:0 6px 24px rgba(0,0,0,0.24)',
  ].join(';')
  document.body.appendChild(element)
  // Any new touch or click dismisses the popup, so it never blocks the editor.
  document.addEventListener(
    'pointerdown',
    () => {
      element.hidden = true
    },
    true
  )
  return element
}

export function hideIssuePopup() {
  if (popup) popup.hidden = true
}

function paintPopup() {
  if (!popup || !popupTheme) return
  popup.style.background = popupTheme.surface
  popup.style.color = popupTheme.foreground
  popup.style.borderColor = popupTheme.line
}

export function restyleIssuePopup(theme: EditorTheme) {
  popupTheme = theme
  paintPopup()
}

type Anchor = { left: number; right: number; top: number; bottom: number }

function showPopup(issue: EditorIssue, theme: EditorTheme, anchor: Anchor) {
  popup ??= createPopup()
  popupTheme = theme
  // A location outside the open note has no squiggle to point at it.
  popup.textContent = issue.path
    ? `${issue.path}${issue.line ? `, line ${issue.line}` : ''}\n${issue.message}`
    : issue.message
  paintPopup()
  // Start from the origin so a stale width cannot skew this measurement.
  popup.style.left = '0px'
  popup.style.top = '0px'
  popup.style.maxWidth = `${Math.max(0, window.innerWidth - 2 * 8)}px`
  popup.hidden = false
  const rect = popup.getBoundingClientRect()
  const margin = 8
  const center = (anchor.left + anchor.right) / 2
  const left = Math.max(
    margin,
    Math.min(center - rect.width / 2, window.innerWidth - rect.width - margin)
  )
  const below = anchor.bottom + 14
  const top =
    below + rect.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, anchor.top - rect.height - 14)
  popup.style.left = `${left}px`
  popup.style.top = `${top}px`
}

function anchorOf(view: EditorView, issue: EditorIssue): Anchor | null {
  const range = issueRange(view.state.doc, issue)
  if (!range) return null
  const from = view.coordsAtPos(range.from)
  const to = view.coordsAtPos(range.to)
  if (!from || !to) return null
  return {
    left: Math.min(from.left, to.left),
    right: Math.max(from.right, to.right),
    top: Math.min(from.top, to.top),
    bottom: Math.max(from.bottom, to.bottom),
  }
}

// A single-character squiggle is hard to hit, so accept taps a little around it.
function nearbyIssue(view: EditorView, x: number, y: number): EditorIssue | null {
  const doc = view.state.doc
  for (const issue of view.state.field(issueField).issues) {
    const range = issueRange(doc, issue)
    if (!range) continue
    const from = view.coordsAtPos(range.from)
    const to = view.coordsAtPos(range.to)
    if (!from || !to) continue
    if (
      x >= Math.min(from.left, to.left) - HIT_X &&
      x <= Math.max(from.right, to.right) + HIT_X &&
      y >= Math.min(from.top, to.top) - HIT_Y &&
      y <= Math.max(from.bottom, to.bottom) + HIT_Y
    )
      return issue
  }
  return null
}

export function applyIssues(view: EditorView, issues: EditorIssue[]) {
  seeded = issues
  view.dispatch({ effects: setIssues.of(issues) })
}

let flashStyle: HTMLStyleElement | null = null
let flashSequence = 0

function flashRange(view: EditorView, range: { from: number; to: number }, theme: EditorTheme) {
  if (!flashStyle) {
    flashStyle = document.createElement('style')
    document.head.appendChild(flashStyle)
  }
  // A muted accent tint over the page, matching the reference pill.
  const tint = `color-mix(in srgb, ${theme.accent} 29%, ${theme.background})`
  flashStyle.textContent = `@keyframes typo-issue-flash {
    0%, 70% { background-color: ${tint}; box-shadow: 0 0 0 4px ${tint}; }
    100% { background-color: transparent; box-shadow: 0 0 0 4px transparent; }
  }`
  const sequence = ++flashSequence
  view.dispatch({ effects: setFlash.of(range) })
  setTimeout(() => {
    if (sequence === flashSequence) view.dispatch({ effects: setFlash.of(null) })
  }, FLASH_MS + 100)
}

export function revealIssue(view: EditorView, index: number, theme: EditorTheme) {
  const issue = view.state.field(issueField, false)?.issues[index]
  if (!issue) return
  const range = issueRange(view.state.doc, issue)
  if (!range) {
    showPopup(issue, theme, {
      left: window.innerWidth / 2,
      right: window.innerWidth / 2,
      top: 64,
      bottom: 64,
    })
    return
  }
  view.dispatch({ selection: { anchor: range.from }, scrollIntoView: true })
  // A one-character error is easy to miss, so flash its whole line.
  const line = view.state.doc.lineAt(range.from)
  if (line.from < line.to) flashRange(view, { from: line.from, to: line.to }, theme)
}

export function seedIssues(issues: EditorIssue[]) {
  seeded = issues
}

// A floating annotation must not outlive the text it points at.
const dismissPopup = ViewPlugin.fromClass(
  class {
    private readonly hide = () => hideIssuePopup()
    constructor(private view: EditorView) {
      view.scrollDOM.addEventListener('scroll', this.hide, { passive: true })
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        (update.focusChanged && !update.view.hasFocus)
      )
        hideIssuePopup()
    }
    destroy() {
      this.view.scrollDOM.removeEventListener('scroll', this.hide)
    }
  }
)

function openIssue(
  event: Event,
  target: EventTarget | null,
  x: number,
  y: number,
  view: EditorView,
  getTheme: () => EditorTheme
): boolean {
  const mark = target instanceof Element ? target.closest('.cm-issue') : null
  const issue = mark
    ? view.state.field(issueField).issues[Number(mark.getAttribute('data-issue'))]
    : nearbyIssue(view, x, y)
  if (!issue) return false
  event.preventDefault()
  event.stopPropagation()
  // The same error always opens at the same place, wherever the tap lands.
  const anchor = anchorOf(view, issue) ?? { left: x, right: x, top: y, bottom: y }
  showPopup(issue, getTheme(), anchor)
  return true
}

export function issueMarks(getTheme: () => EditorTheme) {
  return [
    issueField,
    flashField,
    dismissPopup,
    EditorView.domEventHandlers({
      pointerdown(event, view) {
        return openIssue(event, event.target, event.clientX, event.clientY, view, getTheme)
      },
      touchstart(event, view) {
        const touch = event.touches[0]
        return touch
          ? openIssue(event, event.target, touch.clientX, touch.clientY, view, getTheme)
          : false
      },
      mousedown(event, view) {
        return openIssue(event, event.target, event.clientX, event.clientY, view, getTheme)
      },
    }),
  ]
}
