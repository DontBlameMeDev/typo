import type { EditorTheme } from './document'

export type EditorConfig = {
  documentId: string
  source: string
  theme: EditorTheme
  editable: boolean
}

export type EditorMessage =
  | { type: 'boot' | 'ready' }
  | { type: 'change' | 'save' | 'painted'; documentId: string; source: string }
  | { type: 'error' | 'warning'; message: string }

export function editorMessage(
  json: string,
  documentId: string,
  source?: string
): EditorMessage | null {
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
    'source' in value &&
    typeof value.source === 'string'
  ) {
    if (value.documentId !== documentId) return null
    if (
      value.type === 'painted' &&
      source !== undefined &&
      value.source !== source &&
      value.source !== source.replace(/\r\n?/gu, '\n')
    )
      return null
    return { type: value.type, documentId, source: value.source }
  }
  throw new Error('Invalid editor message.')
}
