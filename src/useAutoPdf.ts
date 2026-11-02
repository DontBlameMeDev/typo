import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { CompilerHandle } from './CompilerHost'
import { CompilerInputs } from './compiler/inputs'
import { CompilationQueue } from './compiler/queue'
import { cacheCompiledPdf } from './compiler/storage'
import type { Note, Vault } from './types'
import { type CompileFile, loadCompileFiles, releasePdf, writeCompiledPdf } from './vault'

type Preview = { source: string; uri: string; base64: string; files: CompileFile[] }
const sameFiles = (a: CompileFile[], b: CompileFile[]) =>
  a.length === b.length &&
  a.every((file, index) => file.path === b[index].path && file.base64 === b[index].base64)
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Cannot update the PDF.'

export function useAutoPdf(input: {
  vault: Vault
  note: Note
  source: string
  saving: boolean
  compiler: RefObject<CompilerHandle | null>
  onPdf(note: Note): void
}) {
  const latest = useRef(input)
  latest.current = input
  const queue = useRef<CompilationQueue<Preview> | null>(null)
  const inputs = useRef<CompilerInputs | null>(null)
  const recheck = useRef<(() => void) | null>(null)
  const inputError = useRef<unknown>(null)
  const cached = useRef<Preview | null>(null)
  const stored = useRef<Preview | null>(null)
  const alive = useRef(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [phase, setPhase] = useState<'pending' | 'ready' | 'error'>('pending')
  const [error, setError] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)

  const request = useCallback((delay = 450, quiet = false, source = latest.current.source) => {
    if (!alive.current) return
    if (!quiet) {
      setPhase('pending')
      setError(null)
    }
    queue.current?.request(source, delay)
  }, [])

  useLayoutEffect(() => {
    alive.current = true
    inputs.current = new CompilerInputs(() => loadCompileFiles(latest.current.vault))
    queue.current = new CompilationQueue<Preview>({
      async run(source, current) {
        const { note, compiler } = latest.current
        if (!inputs.current) throw new Error('The note was closed.')
        const files = (await inputs.current.get()).filter((file) => file.path !== note.path)
        if (!current() || source !== latest.current.source)
          throw new Error('Superseded compilation.')
        if (!inputs.current?.loadedAt)
          throw inputError.current || new Error('Cannot read compiler inputs.')
        inputError.current = null
        if (cached.current?.source === source && sameFiles(cached.current.files, files))
          return cached.current
        setPhase('pending')
        setError(null)
        if (!compiler.current) throw new Error('The compiler is not available.')
        const base64 = await compiler.current.compile({ path: note.path, source, files })
        if (!current() || source !== latest.current.source)
          throw new Error('Superseded compilation.')
        return { source, files, base64, uri: await cacheCompiledPdf(base64) }
      },
      async success(value, current) {
        if (!current() || value.source !== latest.current.source) return
        if (inputError.current) {
          if (cached.current !== value) void releasePdf(value.uri).catch(() => {})
          throw inputError.current
        }
        const previous = cached.current
        cached.current = value
        setPreview(value)
        setPhase('ready')
        setError(null)
        if (previous && previous !== value) void releasePdf(previous.uri).catch(() => {})
        const { note, vault, saving, onPdf } = latest.current
        if (saving || note.source !== value.source || stored.current === value) return
        try {
          const pdfUri = await writeCompiledPdf(vault, note, value.base64)
          if (!current()) return
          stored.current = value
          setStorageError(null)
          onPdf({ ...note, pdfUri })
        } catch (cause) {
          if (current()) setStorageError(`Cannot store the current PDF: ${message(cause)}`)
        }
      },
      error(cause) {
        setPhase('error')
        setError(message(cause))
      },
      discard(value) {
        if (cached.current !== value) void releasePdf(value.uri).catch(() => {})
      },
    })
    let refreshing = false
    const refresh = () => {
      const active = inputs.current
      if (!active || refreshing || AppState.currentState !== 'active') return
      refreshing = true
      void active
        .get(true)
        .then(() => {
          if (alive.current && inputs.current === active) {
            inputError.current = null
            request(0, true)
          }
        })
        .catch((cause: unknown) => {
          if (alive.current && inputs.current === active) {
            inputError.current = new Error(message(cause))
            setPhase('error')
            setError(message(cause))
          }
        })
        .finally(() => {
          refreshing = false
        })
    }
    recheck.current = refresh
    const timer = setInterval(refresh, 15000)
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh()
    })
    return () => {
      alive.current = false
      clearInterval(timer)
      subscription.remove()
      queue.current?.dispose()
      queue.current = null
      inputs.current = null
      recheck.current = null
      inputError.current = null
      if (cached.current) void releasePdf(cached.current.uri).catch(() => {})
      cached.current = null
      stored.current = null
    }
  }, [request])

  useLayoutEffect(() => {
    request(450, false, input.source)
  }, [input.source, request])

  useEffect(() => {
    if (input.saving) return
    void queue.current
      ?.current()
      .then((value) => {
        if (
          alive.current &&
          value.source === input.note.source &&
          latest.current.note.source === input.note.source &&
          stored.current !== value
        )
          request(0, true)
      })
      .catch(() => {})
  }, [input.note.source, input.saving, request])

  const current = useCallback(async () => {
    if (!queue.current) throw new Error('The note was closed.')
    const value = await queue.current.current()
    if (!alive.current) throw new Error('The note was closed.')
    if (inputError.current) throw inputError.current
    return value
  }, [])

  return {
    preview,
    ready: phase === 'ready' && preview?.source === input.source,
    error: phase === 'error' ? error : null,
    storageError,
    current,
    refresh: () => recheck.current?.(),
    didStore: (value: Preview) => {
      stored.current = value
      setStorageError(null)
    },
    retry: () => {
      const previous = cached.current
      cached.current = null
      if (previous) void releasePdf(previous.uri).catch(() => {})
      request(0)
    },
  }
}
