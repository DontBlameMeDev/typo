import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { CompilationQueue } from './compiler/queue'
import type { PdfPreview, PdfWorkspace } from './compiler/workspace'
import { hasCurrentPdf, type Note } from './types'
import { preparePdf, releasePdf } from './vault'

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Cannot update the PDF.'

type Preview = Pick<PdfPreview, 'source' | 'uri'>

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
  const external = useRef<Preview | null>(null)
  const preparing = useRef<Promise<Preview | null> | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [phase, setPhase] = useState<'pending' | 'ready' | 'error'>('pending')
  const [error, setError] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  // A compiled PDF that is at least as new as the note needs no recompilation.
  const fresh = useRef(false)
  fresh.current =
    input.enabled !== false && input.source === input.note.source && hasCurrentPdf(input.note)

  const request = useCallback((delay = 450, quiet = false, source = latest.current.source) => {
    if (latest.current.enabled === false) return
    if (external.current && external.current.source !== source) external.current = null
    if (fresh.current && source === latest.current.note.source) return
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
    external.current = null
    preparing.current = null
    if (input.enabled === false) return
    let cancelled = false
    let copy: string | null = null
    const note = latest.current.note
    const vaultPdf = fresh.current
    queue.current = new CompilationQueue({
      run: (source) => input.workspace.render(latest.current.note, source),
      async success(value) {
        external.current = null
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
    const prepare = async (): Promise<Preview | null> => {
      // A compiled cache record is already a private file the viewer can load, so
      // a current PDF in the vault does not need another copy.
      const cached = await input.workspace.previous(note).catch(() => null)
      if (cached) return cached
      if (!note.pdfUri) return null
      try {
        copy = await preparePdf(note)
        return { source: note.source, uri: copy }
      } catch {
        return null
      }
    }
    preparing.current = prepare()
    void preparing.current.then((value) => {
      if (cancelled) {
        if (copy) void releasePdf(copy).catch(() => {})
        return
      }
      if (value) {
        if (vaultPdf && latest.current.source === note.source) {
          external.current = value
          setPhase('ready')
        }
        setPreview((current) => current ?? value)
      }
      // The initial request was skipped, so compile only when nothing could be shown.
      if (vaultPdf && !value && latest.current.source === note.source) {
        setPhase('pending')
        queue.current?.request(latest.current.source, 0)
      }
    })
    const unsubscribe = input.workspace.subscribeInputs(() => request(0))
    const unsubscribeStatus = input.workspace.subscribe(() =>
      setStorageError(input.workspace.storageError(input.note.path))
    )
    return () => {
      cancelled = true
      if (copy) void releasePdf(copy).catch(() => {})
      external.current = null
      preparing.current = null
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
    if (external.current && external.current.source === latest.current.source)
      return external.current
    if (preparing.current) {
      const value = await preparing.current
      if (value && value === external.current) return value
    }
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
      external.current = null
      preparing.current = null
      setPhase('pending')
      setError(null)
      void input.workspace.refresh().then(() => queue.current?.request(latest.current.source, 0))
    },
  }
}
