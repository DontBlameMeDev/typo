import * as FileSystem from 'expo-file-system/legacy'
import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useColorScheme } from 'react-native'
import type { ThemeSettings } from './theme-data'
import { defaultThemeSettings, parseThemeSettings, resolveTheme } from './theme-data'

export * from './theme-data'

type ThemeContextValue = ReturnType<typeof resolveTheme> & {
  settings: ThemeSettings
  updateSettings: (patch: Partial<ThemeSettings>) => void
  ready: boolean
  persistenceError: string | null
}
const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemDark = useColorScheme() === 'dark'
  const [settings, setSettings] = useState(defaultThemeSettings)
  const [ready, setReady] = useState(false)
  const [persistenceError, setPersistenceError] = useState<string | null>(null)
  const writes = useRef(Promise.resolve())
  const path = FileSystem.documentDirectory
    ? `${FileSystem.documentDirectory}typo-appearance.json`
    : null

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (!path) throw new Error('Appearance storage is unavailable.')
        if ((await FileSystem.getInfoAsync(path)).exists) {
          const saved: unknown = JSON.parse(await FileSystem.readAsStringAsync(path))
          if (!cancelled) setSettings(parseThemeSettings(saved))
        }
      } catch {
        if (!cancelled)
          setPersistenceError(
            'Could not restore appearance. Choose your settings again to save them.'
          )
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path])

  const updateSettings = useCallback((patch: Partial<ThemeSettings>) => {
    setSettings((previous) => parseThemeSettings({ ...previous, ...patch }))
  }, [])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    writes.current = writes.current.then(async () => {
      try {
        if (!path) throw new Error('Appearance storage is unavailable.')
        await FileSystem.writeAsStringAsync(path, JSON.stringify(settings))
        if (!cancelled) setPersistenceError(null)
      } catch {
        if (!cancelled)
          setPersistenceError(
            'Appearance could not be saved. Your selection still applies for this session.'
          )
      }
    })
    return () => {
      cancelled = true
    }
  }, [settings, ready, path])

  const value = useMemo(
    () => ({
      ...resolveTheme(settings, systemDark),
      settings,
      updateSettings,
      ready,
      persistenceError,
    }),
    [settings, systemDark, ready, updateSettings, persistenceError]
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider.')
  return value
}
