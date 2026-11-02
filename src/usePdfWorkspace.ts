import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { CompilerHandle } from './CompilerHost'
import { pdfStorage } from './compiler/pdf-storage'
import { PdfWorkspace } from './compiler/workspace'
import type { Note, Vault } from './types'
import { createPdfWriter, loadCompileFiles } from './vault'

export function usePdfWorkspace(input: {
  vault: Vault | null
  notes: Note[]
  enabled: boolean
  compiler: RefObject<CompilerHandle | null>
}) {
  const latest = useRef(input)
  latest.current = input
  const vault = input.vault
  const workspace = useMemo(() => {
    if (!vault) return null
    return new PdfWorkspace({
      readFiles: () => loadCompileFiles(vault),
      compile: (request) => {
        const compiler = latest.current.compiler.current
        if (!compiler) throw new Error('The compiler is not available.')
        return compiler.compile(request)
      },
      storage: {
        ...pdfStorage(vault.uri),
        write: createPdfWriter(vault),
      },
    })
  }, [vault])
  const [errors, setErrors] = useState(0)

  useEffect(() => {
    if (!workspace) {
      setErrors(0)
      return
    }
    const unsubscribe = workspace.subscribe(() => setErrors(workspace.status.errors))
    const active = AppState.currentState === 'active'
    workspace.setActive(active && latest.current.enabled)
    const timer = setInterval(() => void workspace.refresh(), 15000)
    const subscription = AppState.addEventListener('change', (state) => {
      workspace.setActive(state === 'active' && latest.current.enabled)
      if (state === 'active') void workspace.refresh()
    })
    return () => {
      unsubscribe()
      clearInterval(timer)
      subscription.remove()
      workspace.dispose()
    }
  }, [workspace])

  useEffect(() => {
    workspace?.setActive(input.enabled && AppState.currentState === 'active')
    if (input.enabled) void workspace?.refresh()
  }, [workspace, input.enabled])

  useEffect(() => {
    workspace?.setNotes(input.notes)
  }, [workspace, input.notes])

  return { workspace, errors }
}
