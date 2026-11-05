import type { EditorTheme } from './document'

export type EditorConfig = {
  documentId: string
  source: string
  session: number
  theme: EditorTheme
  editable: boolean
}

export type EditorChange = {
  from: number
  to: number
  insert: string
}

export type EditorMessage =
  | { type: 'boot' | 'ready' }
  | { type: 'change'; documentId: string; session: number; change: EditorChange }
  | { type: 'save'; documentId: string; session: number }
  | { type: 'painted'; documentId: string; session: number }
  | { type: 'error' | 'warning'; message: string }

function session(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function change(value: unknown): value is EditorChange {
  if (!value || typeof value !== 'object') return false
  const { from, to, insert } = value as Record<string, unknown>
  return (
    typeof insert === 'string' &&
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    (from as number) >= 0 &&
    (to as number) >= (from as number)
  )
}

export function applyEditorChange(source: string, edit: EditorChange): string {
  if (!change(edit) || edit.to > source.length)
    throw new Error('The editor sent an invalid change.')
  return source.slice(0, edit.from) + edit.insert + source.slice(edit.to)
}

export function editorMessage(json: string, documentId: string): EditorMessage | null {
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object' || !('type' in value))
    throw new Error('Invalid editor message.')
  if (value.type === 'boot' || value.type === 'ready') return { type: value.type }
  if (
    (value.type === 'error' || value.type === 'warning') &&
    'message' in value &&
    typeof value.message === 'string'
  )
    return { type: value.type, message: value.message }
  if (
    (value.type === 'change' || value.type === 'save' || value.type === 'painted') &&
    'documentId' in value &&
    typeof value.documentId === 'string' &&
    'session' in value &&
    session(value.session)
  ) {
    if (value.documentId !== documentId) return null
    if (value.type === 'change') {
      if (!('change' in value) || !change(value.change)) throw new Error('Invalid editor message.')
      return { type: 'change', documentId, session: value.session, change: value.change }
    }
    return { type: value.type, documentId, session: value.session }
  }
  throw new Error('Invalid editor message.')
}
