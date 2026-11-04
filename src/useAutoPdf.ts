import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { CompilationQueue } from './compiler/queue'
import type { PdfPreview, PdfWorkspace } from './compiler/workspace'
import type { Note } from './types'
import { preparePdf, releasePdf } from './vault'

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Cannot update the PDF.'

export function useAutoPdf(input: {
  note: Note
  source: string
  workspace: PdfWorkspace
  enabled?: boolean
}) {
  const latest = useRef(input)
  latest.current = input
  const queue = useRef<CompilationQueue<PdfPreview> | null>(null)
  const firstRequest = useRef(true)
  const [preview, setPreview] = useState<Pick<PdfPreview, 'source' | 'uri'> | null>(null)
  const [phase, setPhase] = useState<'pending' | 'ready' | 'error'>('pending')
  const [error, setError] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)

  const request = useCallback((delay = 450, quiet = false, source = latest.current.source) => {
    if (latest.current.enabled === false) return
    if (!quiet) {
      setPhase('pending')
      setError(null)
    }
    queue.current?.request(source, delay)
  }, [])

  useLayoutEffect(() => {
    setPreview(null)
    setPhase('pending')
    setError(null)
    setStorageError(null)
    firstRequest.current = true
    if (input.enabled === false) return
    let cancelled = false
    let previousCopy: string | null = null
    const note = latest.current.note
    void input.workspace
      .previous(note)
      .then(async (cached) => {
        let value: Pick<PdfPreview, 'source' | 'uri'> | null = cached
        if (!value && note.pdfUri) {
          previousCopy = await preparePdf(note)
          value = { source: note.source, uri: previousCopy }
        }
        if (cancelled) {
          if (previousCopy) void releasePdf(previousCopy).catch(() => {})
        } else if (value) setPreview((current) => current ?? value)
      })
      .catch(() => {})
    queue.current = new CompilationQueue({
      run: (source) => input.workspace.render(latest.current.note, source),
      async success(value) {
        setPreview(value)
        setPhase('ready')
        setError(null)
      },
      error(cause) {
        setPhase('error')
        setError(message(cause))
      },
      discard() {},
    })
    const unsubscribe = input.workspace.subscribeInputs(() => request(0))
    const unsubscribeStatus = input.workspace.subscribe(() =>
      setStorageError(input.workspace.storageError(input.note.path))
    )
    return () => {
      cancelled = true
      if (previousCopy) void releasePdf(previousCopy).catch(() => {})
      unsubscribe()
      unsubscribeStatus()
      queue.current?.dispose()
      queue.current = null
    }
  }, [input.workspace, input.note.path, input.enabled, request])

  useLayoutEffect(() => {
    if (input.enabled === false) return
    request(firstRequest.current ? 0 : 450, false, input.source)
    firstRequest.current = false
  }, [input.source, input.enabled, request])

  const current = useCallback(async () => {
    if (!queue.current) throw new Error('The note was closed.')
    return queue.current.current()
  }, [])

  return {
    preview,
    error: phase === 'error' ? error : null,
    storageError,
    current,
    retry: () => {
      input.workspace.retry(input.note.path)
      void input.workspace.refresh().then(() => request(0))
    },
  }
}
