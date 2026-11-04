import { createNoteSearch } from '../core'
import type { Note } from '../types'
import type { SearchRequest } from './protocol'

declare global {
  interface Window {
    typoSearch(request: SearchRequest): Promise<void>
  }
}

const notes = new Map<string, Note>()
let search = createNoteSearch([])
let latest = 0
const send = (message: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))

window.typoSearch = async (request) => {
  latest = request.id
  try {
    if (request.updated.length || request.removed.length) {
      for (const note of request.updated)
        notes.set(note.path, {
          ...note,
          source: note.source ?? notes.get(note.path)?.source ?? '',
          uri: note.path,
          modifiedAt: null,
        })
      for (const path of request.removed) notes.delete(path)
      search = createNoteSearch([...notes.values()].sort((a, b) => a.path.localeCompare(b.path)))
    }
    const results = await search(request.query, request.mode, () => latest !== request.id)
    if (latest === request.id)
      send({
        type: 'results',
        id: request.id,
        results: results.map(({ note, line, snippet }) => ({ path: note.path, line, snippet })),
      })
  } catch (cause) {
    if (latest === request.id) send({ type: 'error', id: request.id, message: String(cause) })
  }
}
send({ type: 'boot' })
