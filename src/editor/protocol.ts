import type { EditorTheme } from './document'

export type EditorConfig = {
  documentId: string
  source: string
  theme: EditorTheme
  editable: boolean
}

export type EditorMessage =
  | { type: 'boot' | 'ready' }
  | { type: 'change' | 'save'; documentId: string; source: string }
  | { type: 'error'; message: string }

export function editorMessage(json: string, documentId: string): EditorMessage | null {
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object' || !('type' in value))
    throw new Error('Invalid editor message.')
  if (value.type === 'boot' || value.type === 'ready') return { type: value.type }
  if (value.type === 'error' && 'message' in value && typeof value.message === 'string')
    return { type: 'error', message: value.message }
  if (
    (value.type === 'change' || value.type === 'save') &&
    'documentId' in value &&
    typeof value.documentId === 'string' &&
    'source' in value &&
    typeof value.source === 'string'
  ) {
    if (value.documentId !== documentId) return null
    return { type: value.type, documentId, source: value.source }
  }
  throw new Error('Invalid editor message.')
}
