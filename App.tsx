import { Ionicons } from '@expo/vector-icons'
import { DMSans_400Regular, DMSans_600SemiBold, useFonts } from '@expo-google-fonts/dm-sans'
import { Newsreader_400Regular, Newsreader_400Regular_Italic } from '@expo-google-fonts/newsreader'
import * as Sharing from 'expo-sharing'
import * as SystemUI from 'expo-system-ui'
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AppState,
  BackHandler,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context'
import { type CompilerHandle, CompilerHost } from './src/CompilerHost'
import type { PdfWorkspace } from './src/compiler/workspace'
import { createNoteSearch, reconcileNotes } from './src/core'
import { loadVaultIndex, storeVaultIndex } from './src/library-cache'
import Pdf from './src/PdfViewer'
import { SourceEditor, type SourceEditorHandle } from './src/SourceEditor'
import type { Accent, AppearanceMode, Flavor, ThemeColors } from './src/theme'
import {
  accentNames,
  darkFlavorNames,
  lightFlavorNames,
  luminance,
  palettes,
  ThemeProvider,
  useTheme,
} from './src/theme'
import type { Note, SearchMode, SearchResult, Vault } from './src/types'
import { useAutoPdf } from './src/useAutoPdf'
import { usePdfWorkspace } from './src/usePdfWorkspace'
import {
  createNote,
  listTemplates,
  loadSavedVault,
  type NoteTemplate,
  pickVault,
  preparePdf,
  prepareSource,
  readNote,
  saveNote,
  scanVault,
} from './src/vault'
import { webRuntime } from './src/web-runtime'

const fonts = {
  DMSans_400Regular,
  DMSans_600SemiBold,
  Newsreader_400Regular,
  Newsreader_400Regular_Italic,
}
type NoteSession = SearchResult & { session: number; opening?: boolean; openError?: string }
type NoteOptions = { templates: NoteTemplate[] }
const warmNote: Note = { uri: '', path: '', title: '', source: '', modifiedAt: null }

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.'

function Icon({
  name,
  size = 21,
  color,
}: {
  name: React.ComponentProps<typeof Ionicons>['name']
  size?: number
  color?: string
}) {
  const { colors } = useTheme()
  return <Ionicons accessible={false} name={name} size={size} color={color ?? colors.ink} />
}
function IconButton({
  name,
  label,
  onPress,
  disabled = false,
}: {
  name: React.ComponentProps<typeof Ionicons>['name']
  label: string
  onPress: () => void
  disabled?: boolean
}) {
  const s = useStyles()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.iconButton, pressed && s.pressed, disabled && s.disabled]}
    >
      <Icon name={name} />
    </Pressable>
  )
}
function Action({
  label,
  onPress,
  busy = false,
  disabled = false,
  icon,
}: {
  label: string
  onPress: () => void
  busy?: boolean
  disabled?: boolean
  icon?: React.ComponentProps<typeof Ionicons>['name']
}) {
  const s = useStyles()
  const { colors } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [s.action, pressed && s.pressed, (disabled || busy) && s.disabled]}
    >
      {icon ? <Icon name={icon} size={19} color={colors.onAccent} /> : null}
      <Text style={s.actionText}>{label}</Text>
    </Pressable>
  )
}
function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  const s = useStyles()
  const { colors } = useTheme()
  return (
    <View accessibilityLiveRegion="polite" style={s.error}>
      <Icon name="alert-circle-outline" color={colors.coral} />
      <Text selectable style={s.errorText}>
        {message}
      </Text>
      {onDismiss && <IconButton name="close" label="Dismiss error" onPress={onDismiss} />}
    </View>
  )
}
function Segments<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[]
  value: T
  onChange: (value: T) => void
}) {
  const s = useStyles()
  return (
    <View style={s.segments}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: option.value === value }}
          onPress={() => onChange(option.value)}
          style={[s.segment, option.value === value && s.segmentActive]}
        >
          <Text style={[s.segmentText, option.value === value && s.segmentTextActive]}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}
function Screen({
  onClose,
  visible = true,
  children,
}: {
  onClose: () => void
  visible?: boolean
  children: React.ReactNode
}) {
  const { top, right, bottom, left } = useSafeAreaInsets()
  const { colors } = useTheme()
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    if (!visible) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close.current()
      return true
    })
    return () => subscription.remove()
  }, [visible])
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        {
          zIndex: visible ? 2 : 0,
          elevation: visible ? 4 : 0,
          backgroundColor: colors.paper,
          paddingTop: top,
          paddingRight: right,
          paddingBottom: bottom,
          paddingLeft: left,
        },
      ]}
      pointerEvents={visible ? 'auto' : 'none'}
      accessibilityViewIsModal={visible}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
    >
      {children}
    </View>
  )
}

function Dialog({
  visible,
  title,
  message,
  onClose,
  children,
}: {
  visible: boolean
  title: string
  message?: string
  onClose(): void
  children: React.ReactNode
}) {
  const s = useStyles()
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      hardwareAccelerated
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={s.dialogOverlay}>
        <Pressable
          accessibilityLabel="Dismiss dialog"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View style={s.dialogCard} accessibilityViewIsModal>
          <Text accessible accessibilityRole="header" style={s.dialogTitle}>
            {title}
          </Text>
          {message && (
            <Text accessible style={s.dialogMessage}>
              {message}
            </Text>
          )}
          {children}
        </View>
      </View>
    </Modal>
  )
}

function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Keep editing',
  onCancel,
  onConfirm,
}: {
  visible: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const s = useStyles()
  if (!visible) return null
  return (
    <Dialog visible={visible} title={title} message={message} onClose={onCancel}>
      <View style={s.dialogActions}>
        <Pressable
          accessibilityRole="button"
          onPress={onCancel}
          style={({ pressed }) => [s.dialogCancel, pressed && s.pressed]}
        >
          <Text style={s.dialogCancelText}>{cancelLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onConfirm}
          style={({ pressed }) => [s.dialogConfirm, pressed && s.pressed]}
        >
          <Text style={s.dialogConfirmText}>{confirmLabel}</Text>
        </Pressable>
      </View>
    </Dialog>
  )
}

export default function App() {
  const [loaded, fontError] = useFonts(fonts)
  return (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <AppShell loaded={loaded || !!fontError} />
      </SafeAreaProvider>
    </ThemeProvider>
  )
}

function AppShell({ loaded }: { loaded: boolean }) {
  const { colors, isDark } = useTheme()
  const s = useStyles()
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.paper).catch(() => {})
  }, [colors.paper])
  return (
    <>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      {loaded ? <Library /> : <View style={s.loadingScreen} />}
    </>
  )
}

function Library() {
  const s = useStyles()
  const { top, right, bottom, left } = useSafeAreaInsets()
  const { colors, palette } = useTheme()
  const [vault, setVault] = useState<Vault | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [restoring, setRestoring] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('all')
  const [selected, setSelected] = useState<NoteSession | null>(null)
  const [prepared, setPrepared] = useState<NoteSession | null>(null)
  const pendingNote = useRef<NoteSession | null>(null)
  const noteSession = useRef(0)
  const [creating, setCreating] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [noteOptions, setNoteOptions] = useState<{ vault: string; options: NoteOptions } | null>(
    null
  )
  const compiler = useRef<CompilerHandle>(null)
  const generation = useRef(0)
  const mounted = useRef(true)
  const scanningRef = useRef(false)
  const vaultRef = useRef<Vault | null>(null)
  const busy = useRef(false)
  const modalWasOpen = useRef(false)
  const foreground = useRef(AppState.currentState === 'active')
  busy.current = restoring || picking

  const index = useCallback(async (target: Vault, options?: { quiet?: boolean }) => {
    if (scanningRef.current) return
    const quiet = options?.quiet === true
    const started = performance.now()
    let firstBatch = true
    const request = ++generation.current
    scanningRef.current = true
    if (!quiet) {
      setScanning(true)
      setError(null)
    }
    try {
      const result = await scanVault(
        target,
        undefined,
        () => !mounted.current || request !== generation.current,
        quiet
          ? undefined
          : (partial) => {
              if (mounted.current && request === generation.current) {
                if (__DEV__ && firstBatch) {
                  console.info(
                    `[performance] First notes: ${Math.round(performance.now() - started)} ms`
                  )
                  firstBatch = false
                }
                setNotes(partial)
              }
            }
      )
      if (mounted.current && request === generation.current) {
        setNotes((previous) => reconcileNotes(previous, result))
        setError(null)
        if (__DEV__)
          console.info(
            `[performance] Vault scan: ${result.length} notes in ${Math.round(performance.now() - started)} ms`
          )
      }
    } catch (cause) {
      if (mounted.current && request === generation.current) setError(errorText(cause))
    } finally {
      if (mounted.current && request === generation.current) {
        scanningRef.current = false
        if (!quiet) setScanning(false)
      }
    }
  }, [])

  const quietScan = useCallback(() => {
    const target = vaultRef.current
    if (!target || scanningRef.current || busy.current) return
    if (!foreground.current) return
    void index(target, { quiet: true })
  }, [index])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    const started = performance.now()
    void (async () => {
      try {
        const saved = await loadSavedVault()
        if (cancelled) return
        if (saved) {
          setVault(saved)
          vaultRef.current = saved
          const cached = await loadVaultIndex(saved)
          if (cancelled) return
          if (cached) {
            setNotes(cached)
            if (__DEV__)
              console.info(
                `[performance] Cached library: ${cached.length} notes in ${Math.round(performance.now() - started)} ms`
              )
          }
          setRestoring(false)
          await index(saved, { quiet: !!cached })
        }
      } catch (cause) {
        if (!cancelled) setError(errorText(cause))
      } finally {
        if (!cancelled) setRestoring(false)
      }
    })()
    return () => {
      cancelled = true
      mounted.current = false
      generation.current++
    }
  }, [index])

  useEffect(() => {
    foreground.current = AppState.currentState === 'active'
    const listener = AppState.addEventListener('change', (state) => {
      foreground.current = state === 'active'
      if (state === 'active') quietScan()
    })
    return () => listener.remove()
  }, [quietScan])

  useEffect(() => {
    if (!vault || restoring || scanning || picking) return
    const timer = setTimeout(() => {
      void storeVaultIndex(vault, notes).catch(() => {})
    }, 300)
    return () => clearTimeout(timer)
  }, [vault, notes, restoring, scanning, picking])

  useEffect(() => {
    const timer = setInterval(quietScan, 15_000)
    return () => clearInterval(timer)
  }, [quietScan])

  useEffect(() => {
    const open = !!selected || creating || appearanceOpen
    if (modalWasOpen.current && !open) quietScan()
    modalWasOpen.current = open
  }, [selected, creating, appearanceOpen, quietScan])

  async function chooseVault() {
    if (picking || restoring) return
    Keyboard.dismiss()
    setPicking(true)
    setError(null)
    try {
      const next = await pickVault()
      if (!mounted.current || !next) return
      generation.current++
      scanningRef.current = false
      setVault(next)
      vaultRef.current = next
      setNotes([])
      setPrepared(null)
      pendingNote.current = null
      const cached = await loadVaultIndex(next)
      if (!mounted.current) return
      setNotes(cached || [])
      setQuery('')
      await index(next, { quiet: !!cached })
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setPicking(false)
    }
  }

  const deferredQuery = useDeferredValue(query)
  const searchNotes = useMemo(() => createNoteSearch(notes), [notes])
  const results = useMemo(
    () => searchNotes(deferredQuery, mode),
    [searchNotes, deferredQuery, mode]
  )
  const isSearching = query.trim().length > 0
  const stopIndex = useCallback(() => {
    generation.current++
    scanningRef.current = false
    setScanning(false)
  }, [])
  const prepareNote = useCallback((result: SearchResult) => {
    Keyboard.dismiss()
    const next = { ...result, session: ++noteSession.current }
    pendingNote.current = next
    setPrepared(next)
    return next
  }, [])
  const openNote = useCallback(
    async (result: SearchResult) => {
      const next =
        pendingNote.current?.note.uri === result.note.uri
          ? pendingNote.current
          : prepareNote(result)
      pendingNote.current = null
      stopIndex()
      Keyboard.dismiss()
      const request = generation.current
      setSelected({ ...next, opening: true })
      try {
        const note = await readNote(result.note)
        if (!mounted.current || request !== generation.current) return
        setNotes((previous) => previous.map((item) => (item.uri === note.uri ? note : item)))
        setPrepared((current) =>
          current?.session === next.session ? { ...current, note } : current
        )
        setSelected((current) =>
          current?.session === next.session ? { ...current, note, opening: false } : current
        )
      } catch (cause) {
        if (mounted.current && request === generation.current) {
          const message = errorText(cause)
          setError(message)
          setSelected((current) =>
            current?.note.uri === result.note.uri
              ? { ...current, opening: false, openError: message }
              : current
          )
        }
      }
    },
    [prepareNote, stopIndex]
  )
  const updateNote = (note: Note) => {
    stopIndex()
    setNotes((previous) => previous.map((item) => (item.uri === note.uri ? note : item)))
    setPrepared((current) => (current?.note.uri === note.uri ? { ...current, note } : current))
    setSelected((current) =>
      current?.note.uri === note.uri ? { ...current, note, openError: undefined } : current
    )
    setError(null)
  }

  const { workspace, errors: pdfErrors } = usePdfWorkspace({
    vault,
    notes,
    enabled: !restoring && !scanning && !picking,
    compiler,
  })

  useEffect(() => {
    if (!vault) return
    void webRuntime('editor').catch(() => {})
    let cancelled = false
    void listTemplates(vault)
      .then((templates) => {
        if (!cancelled) setNoteOptions({ vault: vault.uri, options: { templates } })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [vault])

  useEffect(() => {
    if (!vault || restoring || scanning) return
    const timer = setTimeout(() => {
      void webRuntime('pdf').catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [vault, restoring, scanning])

  const detail = selected ?? prepared
  const libraryVisible = !selected && !creating && !appearanceOpen
  return (
    <View style={s.screen}>
      <View
        style={[
          s.screen,
          {
            zIndex: 1,
            paddingTop: top,
            paddingRight: right,
            paddingBottom: bottom,
            paddingLeft: left,
          },
        ]}
        pointerEvents={libraryVisible ? 'auto' : 'none'}
        accessibilityElementsHidden={!libraryVisible}
        importantForAccessibility={libraryVisible ? 'auto' : 'no-hide-descendants'}
      >
        <View style={s.header}>
          <View style={s.brandLockup}>
            <Image
              source={require('./assets/icon.png')}
              style={s.brandImage}
              accessibilityIgnoresInvertColors
            />
            <Text style={s.brand}>Typo</Text>
          </View>
          <View style={s.headerRight}>
            <IconButton
              name="settings-outline"
              label="Appearance settings"
              onPress={() => {
                Keyboard.dismiss()
                setAppearanceOpen(true)
              }}
            />
            {vault && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Notes folder: ${vault.name}. Choose folder`}
                disabled={picking}
                onPress={() => void chooseVault()}
                style={s.folderButton}
              >
                <Icon name="folder-open-outline" size={16} />
                <Text numberOfLines={1} style={s.folderName}>
                  {vault.name}
                </Text>
                <Icon name="chevron-down" size={15} />
              </Pressable>
            )}
          </View>
        </View>
        {error && (
          <View style={s.errorInset}>
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </View>
        )}
        {restoring ? (
          <View style={s.flex} />
        ) : !vault ? (
          <ScrollView contentContainerStyle={s.onboarding} keyboardShouldPersistTaps="handled">
            <View style={s.illustration}>
              <View style={s.paperBack} />
              <View style={s.paperFront}>
                <Text style={s.paperSource} accessible={false} allowFontScaling={false}>
                  <Text style={{ color: palette.mauve }}>#set</Text>{' '}
                  <Text style={{ color: palette.blue }}>page</Text>
                  {'(paper: '}
                  <Text style={{ color: palette.green }}>{'"a5"'}</Text>
                  {', margin: '}
                  <Text style={{ color: palette.peach }}>1.5cm</Text>
                  {')\n'}
                  <Text style={{ color: palette.mauve }}>#set</Text>{' '}
                  <Text style={{ color: palette.blue }}>text</Text>
                  {'(font: '}
                  <Text style={{ color: palette.green }}>{'"Libertinus Serif"'}</Text>
                  {')\n'}
                  <Text style={{ color: palette.mauve }}>#set</Text>{' '}
                  <Text style={{ color: palette.blue }}>par</Text>
                  {'(justify: '}
                  <Text style={{ color: palette.mauve }}>true</Text>
                  {')\n\n'}
                  <Text style={{ color: colors.accent }}>{'= Field notes\n\n'}</Text>
                  <Text style={{ color: colors.accent }}>{'== A series and its limit\n\n'}</Text>
                  {'For '}
                  <Text style={{ color: palette.yellow }}>{'$|x| < 1$'}</Text>
                  {', the geometric series\nconverges to a simple expression:\n\n'}
                  <Text style={{ color: palette.yellow }}>
                    {'$ sum_(n=0)^infinity x^n = 1/(1-x) $'}
                  </Text>
                  {'\n\n'}
                  <Text style={{ color: colors.accent }}>{'== Observations\n\n'}</Text>
                  {
                    '- Start with the partial sums.\n- Compare consecutive terms.\n- Take the limit as '
                  }
                  <Text style={{ color: palette.yellow }}>{'$n -> infinity$'}</Text>
                  {'.\n\n'}
                  <Text style={{ color: palette.blue }}>#align</Text>
                  {'(right)[Q.E.D.]'}
                </Text>
              </View>
              <View style={s.penBadge}>
                <Icon name="pencil-outline" size={25} color={colors.onAccent} />
              </View>
            </View>
            <Text style={s.welcomeTitle}>Good things start{'\n'}with a little note.</Text>
            <Action
              label="Open notes folder"
              icon="folder-open-outline"
              onPress={() => void chooseVault()}
              busy={picking}
            />
          </ScrollView>
        ) : (
          <>
            <View style={s.libraryTop}>
              <View style={s.search}>
                <Icon name="search-outline" color={colors.muted} />
                <TextInput
                  accessibilityLabel="Search notes"
                  placeholder="Find a thought…"
                  placeholderTextColor={colors.muted}
                  value={query}
                  onChangeText={setQuery}
                  style={s.searchInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {query.length > 0 && (
                  <IconButton
                    name="close-circle"
                    label="Clear search"
                    onPress={() => setQuery('')}
                  />
                )}
              </View>
              <View style={{ marginTop: 12 }}>
                <Segments
                  options={[
                    { label: 'All', value: 'all' },
                    { label: 'Names', value: 'names' },
                    { label: 'Content', value: 'content' },
                  ]}
                  value={mode}
                  onChange={setMode}
                />
              </View>
              <View style={s.listMeta}>
                <Text accessibilityLiveRegion="polite" style={s.eyebrow}>
                  {`${results.length} ${isSearching ? 'RESULT' : 'NOTE'}${results.length === 1 ? '' : 'S'}`}
                </Text>
                {pdfErrors > 0 ? (
                  <Text accessibilityLiveRegion="polite" style={s.muted}>
                    {pdfErrors} note{pdfErrors === 1 ? '' : 's'} could not be compiled
                  </Text>
                ) : null}
              </View>
            </View>
            <FlatList
              bounces={false}
              alwaysBounceVertical={false}
              overScrollMode="never"
              initialNumToRender={12}
              maxToRenderPerBatch={16}
              updateCellsBatchingPeriod={16}
              data={results}
              keyExtractor={(item) => item.note.uri}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={[s.list, results.length === 0 && s.emptyList]}
              renderItem={({ item }) => (
                <NoteRow result={item} onPressIn={prepareNote} onPress={openNote} />
              )}
              ListEmptyComponent={
                !scanning ? (
                  <View style={s.empty}>
                    <View style={s.emptyIcon}>
                      <Icon
                        name={isSearching ? 'search-outline' : 'document-text-outline'}
                        size={28}
                      />
                    </View>
                    <Text style={s.emptyTitle}>
                      {isSearching ? 'No notes found.' : 'A fresh page awaits.'}
                    </Text>
                    <Text style={s.emptyBody}>
                      {isSearching
                        ? 'Try a different word or search in All.'
                        : 'Create your first note, or add .typ files to this folder. They’ll feel right at home.'}
                    </Text>
                    {!scanning &&
                      (isSearching ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => setQuery('')}
                          style={s.textLink}
                        >
                          <Text style={s.linkText}>Clear search</Text>
                        </Pressable>
                      ) : (
                        <Action
                          label="Write your first note"
                          icon="add"
                          onPress={() => {
                            stopIndex()
                            setCreating(true)
                          }}
                        />
                      ))}
                  </View>
                ) : undefined
              }
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create a new note"
              onPress={() => {
                Keyboard.dismiss()
                stopIndex()
                setCreating(true)
              }}
              onPressIn={Keyboard.dismiss}
              style={({ pressed }) => [s.fab, pressed && s.pressed]}
            >
              <Icon name="add" size={23} color={colors.onAccent} />
              <Text style={s.fabText}>New note</Text>
            </Pressable>
          </>
        )}
      </View>
      {workspace && <CompilerHost key={vault?.uri} ref={compiler} />}
      {vault && workspace && (
        <NoteDetail
          key={`detail:${vault.uri}`}
          workspace={workspace}
          active={!!selected}
          session={detail?.session ?? 0}
          note={detail?.note ?? warmNote}
          opening={!!selected?.opening}
          openError={selected?.openError}
          initialLine={detail?.line}
          initialQuery={isSearching && detail?.line ? query : ''}
          onClose={() => {
            pendingNote.current = null
            setSelected(null)
          }}
          onSave={updateNote}
        />
      )}
      {creating && vault && (
        <NewNote
          vault={vault}
          options={noteOptions?.vault === vault.uri ? noteOptions.options : undefined}
          onClose={() => setCreating(false)}
          onCreated={(note) => {
            stopIndex()
            setNotes((previous) => [...previous, note].sort((a, b) => a.path.localeCompare(b.path)))
            setQuery('')
            setCreating(false)
            setSelected(prepareNote({ note }))
          }}
        />
      )}
      {appearanceOpen && <AppearanceSettings onClose={() => setAppearanceOpen(false)} />}
    </View>
  )
}

const NoteRow = memo(
  function NoteRow({
    result,
    onPressIn,
    onPress,
  }: {
    result: SearchResult
    onPressIn: (result: SearchResult) => void
    onPress: (result: SearchResult) => void
  }) {
    const s = useStyles()
    const { colors } = useTheme()
    const { note, snippet, line } = result
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${note.title}, ${note.path}`}
        onPressIn={() => onPressIn(result)}
        onPress={() => onPress(result)}
        style={({ pressed }) => [s.noteRow, pressed && s.rowPressed]}
      >
        <View style={s.noteGlyph}>
          <Icon name="document-text-outline" size={22} />
        </View>
        <View style={s.noteInfo}>
          <Text numberOfLines={2} style={s.noteTitle}>
            {note.title}
          </Text>
          <Text numberOfLines={1} style={s.notePath}>
            {note.path}
          </Text>
          {snippet ? (
            <Text numberOfLines={2} style={s.snippet}>
              {line ? `L${line} · ` : ''}
              {snippet.trim()}
            </Text>
          ) : null}
        </View>
        <Icon name="chevron-forward" size={16} color={colors.muted} />
      </Pressable>
    )
  },
  (previous, next) =>
    previous.result.note === next.result.note &&
    previous.result.snippet === next.result.snippet &&
    previous.result.line === next.result.line &&
    previous.onPressIn === next.onPressIn &&
    previous.onPress === next.onPress
)

function NoteDetail({
  workspace,
  active,
  session,
  note,
  opening = false,
  openError,
  initialLine,
  initialQuery,
  onClose,
  onSave,
}: {
  workspace: PdfWorkspace
  active: boolean
  session: number
  note: Note
  opening?: boolean
  openError?: string
  initialLine?: number
  initialQuery: string
  onClose: () => void
  onSave: (note: Note) => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const documentId = `${note.uri}:${session}`
  const [currentDocument, setCurrentDocument] = useState(documentId)
  const [savedNote, setSavedNote] = useState(note)
  const [source, setSource] = useState(note.source)
  const [mode, setMode] = useState<'source' | 'pdf'>('source')
  const [find, setFind] = useState(initialQuery)
  const [findOpen, setFindOpen] = useState(!!initialQuery || !!initialLine)
  const [focusFind, setFocusFind] = useState(false)
  const findInput = useRef<React.ComponentRef<typeof TextInput>>(null)
  const [matchIndex, setMatchIndex] = useState(0)
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>()
  const [saving, setSaving] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const shareEpoch = useRef(0)
  const alive = useRef(true)
  const editor = useRef<SourceEditorHandle>(null)
  const editState = useRef({ documentId, source, savedNote })
  editState.current = { documentId, source, savedNote }
  useLayoutEffect(() => {
    const current = editState.current
    if (note.source === current.savedNote.source) return
    if (current.source === current.savedNote.source) {
      setSavedNote(note)
      setSource(note.source)
    } else {
      setError(
        'The file changed on disk while opening. Your edits have been kept. Reopen the note to load the file.'
      )
    }
  }, [note])
  const dirty = source !== savedNote.source
  const autoPdf = useAutoPdf({ note: savedNote, source, workspace, enabled: active })
  useEffect(() => {
    if (autoPdf.preview?.uri) setPdfError(null)
  }, [autoPdf.preview?.uri])
  const matches = useMemo(() => {
    if (!find) return []
    const haystack = source.toLocaleLowerCase(),
      needle = find.toLocaleLowerCase()
    const found: number[] = []
    let offset = 0
    while (offset <= haystack.length) {
      const at = haystack.indexOf(needle, offset)
      if (at < 0) break
      found.push(at)
      offset = at + Math.max(1, needle.length)
    }
    return found
  }, [source, find])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    const current = editState.current
    if (current.documentId !== documentId || current.source !== current.savedNote.source) return
    if (initialLine) {
      const lines = note.source.split('\n')
      const line = lines[initialLine - 1] || ''
      const offset =
        lines.slice(0, Math.max(0, initialLine - 1)).join('\n').length + (initialLine > 1 ? 1 : 0)
      const match = initialQuery
        ? line.toLocaleLowerCase().indexOf(initialQuery.toLocaleLowerCase())
        : -1
      const start = offset + Math.max(0, match)
      setSelection({ start, end: match >= 0 ? start + initialQuery.length : offset + line.length })
      if (match >= 0)
        setMatchIndex(
          note.source.slice(0, start).toLocaleLowerCase().split(initialQuery.toLocaleLowerCase())
            .length - 1
        )
    } else if (initialQuery) {
      const start = note.source.toLocaleLowerCase().indexOf(initialQuery.toLocaleLowerCase())
      if (start >= 0) setSelection({ start, end: start + initialQuery.length })
    }
  }, [initialLine, initialQuery, note.source, documentId])

  if (currentDocument !== documentId) {
    setCurrentDocument(documentId)
    setSavedNote(note)
    setSource(note.source)
    setMode('source')
    setFind(initialQuery)
    setFindOpen(!!initialQuery || !!initialLine)
    setFocusFind(false)
    setMatchIndex(0)
    setSelection(undefined)
    setSaving(false)
    setSharing(false)
    setConfirmAction(null)
    setError(null)
    setPdfError(null)
  }

  const close = () => {
    if (saving) return
    shareEpoch.current++
    setSharing(false)
    if (confirmAction) {
      setConfirmAction(null)
      return
    }
    editor.current?.blur()
    Keyboard.dismiss()
    if (dirty) setConfirmAction(() => onClose)
    else onClose()
  }
  function switchMode(next: 'source' | 'pdf') {
    if (next === mode || saving || sharing) return
    editor.current?.blur()
    Keyboard.dismiss()
    setMode(next)
  }
  async function save(nextSource = source) {
    if (!active || opening || saving || sharing || nextSource === savedNote.source) return
    setSource(nextSource)
    setSaving(true)
    setError(null)
    try {
      const saved = await saveNote(savedNote, nextSource)
      if (!alive.current) return
      const updated = { ...savedNote, ...saved }
      setSavedNote(updated)
      onSave(updated)
    } catch (cause) {
      if (alive.current) setError(errorText(cause))
    } finally {
      if (alive.current) setSaving(false)
    }
  }
  async function share() {
    if (!active || opening || sharing || saving) return
    const epoch = ++shareEpoch.current
    const current = () => alive.current && shareEpoch.current === epoch
    setSharing(true)
    setError(null)
    try {
      if (!(await Sharing.isAvailableAsync()))
        throw new Error('Sharing is not available on this device.')
      if (mode === 'source') {
        const uri = await prepareSource(savedNote, source)
        if (current())
          await Sharing.shareAsync(uri, {
            mimeType: 'application/octet-stream',
            dialogTitle: savedNote.title,
            UTI: 'public.data',
          })
      } else {
        const preview = await autoPdf.current()
        if (!current()) return
        const uri = await preparePdf({ ...savedNote, pdfUri: preview.uri })
        if (current())
          await Sharing.shareAsync(uri, {
            mimeType: 'application/pdf',
            dialogTitle: savedNote.title,
            UTI: 'com.adobe.pdf',
          })
      }
    } catch (cause) {
      if (current()) setError(errorText(cause))
    } finally {
      if (current()) setSharing(false)
    }
  }
  function changeFind(value: string) {
    setFind(value)
    setMatchIndex(0)
    const start = value ? source.toLocaleLowerCase().indexOf(value.toLocaleLowerCase()) : -1
    setSelection(start >= 0 ? { start, end: start + value.length } : undefined)
  }
  function moveMatch(direction: number) {
    if (!matches.length) return
    const next =
      (Math.min(matchIndex, matches.length - 1) + direction + matches.length) % matches.length
    setMatchIndex(next)
    setSelection({ start: matches[next], end: matches[next] + find.length })
    editor.current?.focus()
  }

  return (
    <Screen onClose={close} visible={active}>
      <View style={s.screen}>
        <KeyboardAvoidingView
          style={s.flex}
          enabled={Platform.OS === 'ios' && active}
          importantForAccessibility={confirmAction ? 'no-hide-descendants' : 'auto'}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={s.detailToolbar}>
            <IconButton name="arrow-back" label="Back to notes" onPress={close} disabled={saving} />
            <View style={s.toolbarTitle}>
              <Text numberOfLines={1} style={s.toolbarHeading}>
                {savedNote.title}
              </Text>
              <Text numberOfLines={1} style={s.notePath}>
                {savedNote.path}
              </Text>
            </View>
            <IconButton
              name="share-outline"
              label={mode === 'source' ? 'Share Typst source' : 'Share PDF'}
              onPress={() => void share()}
              disabled={
                opening || sharing || saving || (mode === 'pdf' && (!!autoPdf.error || !!pdfError))
              }
            />
          </View>
          <View style={s.detailControls}>
            <View style={s.flex}>
              <Segments
                options={[
                  { label: 'Source', value: 'source' },
                  { label: 'PDF', value: 'pdf' },
                ]}
                value={mode}
                onChange={switchMode}
              />
            </View>
            {mode === 'source' && (
              <IconButton
                name={findOpen ? 'close' : 'search-outline'}
                label={findOpen ? 'Close find' : 'Find in note'}
                onPress={() => {
                  if (findOpen) {
                    if (findInput.current?.isFocused()) Keyboard.dismiss()
                  } else {
                    editor.current?.blur()
                  }
                  setFocusFind(!findOpen)
                  setFindOpen(!findOpen)
                  setSelection(undefined)
                }}
              />
            )}
          </View>
          {(error || openError || autoPdf.storageError) && (
            <View style={s.errorInset}>
              <ErrorBanner
                message={error || openError || autoPdf.storageError || ''}
                onDismiss={error ? () => setError(null) : undefined}
              />
            </View>
          )}
          <View style={s.flex}>
            <View
              style={[s.flex, mode !== 'source' && { display: 'none' }]}
              importantForAccessibility={mode === 'source' ? 'auto' : 'no-hide-descendants'}
            >
              {findOpen && (
                <View style={s.findBar}>
                  <Icon name="search-outline" size={18} color={colors.muted} />
                  <TextInput
                    ref={findInput}
                    accessibilityLabel="Find in source"
                    autoFocus={focusFind}
                    selectTextOnFocus
                    placeholder="Find in this note"
                    placeholderTextColor={colors.muted}
                    value={find}
                    onChangeText={changeFind}
                    style={s.findInput}
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                    onSubmitEditing={() => moveMatch(1)}
                  />
                  <Text accessibilityLiveRegion="polite" style={s.findCount}>
                    {matches.length
                      ? `${Math.min(matchIndex + 1, matches.length)}/${matches.length}`
                      : '0/0'}
                  </Text>
                  <IconButton
                    name="chevron-up"
                    label="Previous match"
                    onPress={() => moveMatch(-1)}
                    disabled={!matches.length}
                  />
                  <IconButton
                    name="chevron-down"
                    label="Next match"
                    onPress={() => moveMatch(1)}
                    disabled={!matches.length}
                  />
                </View>
              )}
              <SourceEditor
                ref={editor}
                documentId={documentId}
                value={source}
                onChangeText={(text) => {
                  setSource(text)
                  setSelection(undefined)
                }}
                selection={selection}
                editable={active && mode === 'source' && !saving && !sharing}
                onError={(message) => setError(message)}
                onSave={(text) => void save(text)}
              />
              <View style={s.sourceFooter}>
                <Action
                  label="Save"
                  onPress={() => void save()}
                  busy={saving}
                  disabled={opening || !dirty || sharing}
                />
              </View>
            </View>
            <View
              style={[StyleSheet.absoluteFill, { opacity: mode === 'pdf' ? 1 : 0 }]}
              pointerEvents={mode === 'pdf' ? 'auto' : 'none'}
              accessibilityElementsHidden={mode !== 'pdf'}
              importantForAccessibility={mode === 'pdf' ? 'auto' : 'no-hide-descendants'}
            >
              {(autoPdf.error || pdfError) && (
                <View style={s.errorInset}>
                  <ErrorBanner message={autoPdf.error || pdfError || ''} />
                  <Action
                    label="Retry PDF"
                    onPress={() => {
                      setPdfError(null)
                      autoPdf.retry()
                    }}
                  />
                </View>
              )}
              {autoPdf.preview && !pdfError ? (
                <Pdf
                  source={{ uri: autoPdf.preview.uri }}
                  style={s.pdf}
                  onError={(cause) => setPdfError(errorText(cause))}
                />
              ) : null}
            </View>
          </View>
        </KeyboardAvoidingView>
        <ConfirmDialog
          visible={active && !!confirmAction}
          title="Leave unsaved changes?"
          message="Your changes haven’t been saved to the notes folder."
          confirmLabel="Discard changes"
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => {
            const action = confirmAction
            setConfirmAction(null)
            action?.()
          }}
        />
      </View>
    </Screen>
  )
}

function NewNote({
  vault,
  options,
  onClose,
  onCreated,
}: {
  vault: Vault
  options?: NoteOptions
  onClose: () => void
  onCreated: (note: Note) => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [templates, setTemplates] = useState<NoteTemplate[]>(options?.templates ?? [])
  const [templateId, setTemplateId] = useState(options?.templates[0]?.id ?? '')
  const [templatesLoading, setTemplatesLoading] = useState(!options)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void listTemplates(vault)
      .then((items) => {
        if (!alive.current) return
        setTemplates(items)
        setTemplateId((current) =>
          items.some((item) => item.id === current) ? current : (items[0]?.id ?? '')
        )
      })
      .catch((cause: unknown) => {
        if (alive.current) setError(errorText(cause))
      })
      .finally(() => {
        if (alive.current) setTemplatesLoading(false)
      })
    return () => {
      alive.current = false
    }
  }, [vault])
  const close = () => {
    if (saving) return
    if (confirming) {
      setConfirming(false)
      return
    }
    Keyboard.dismiss()
    if (title || body) setConfirming(true)
    else onClose()
  }
  async function create() {
    const template = templates.find((item) => item.id === templateId)
    if (!title.trim() || saving || !template) return
    setSaving(true)
    setError(null)
    try {
      const note = await createNote(vault, title.trim(), body, '', template.source)
      if (alive.current) onCreated(note)
    } catch (cause) {
      if (alive.current) setError(errorText(cause))
    } finally {
      if (alive.current) setSaving(false)
    }
  }
  return (
    <Screen onClose={close}>
      <View style={s.screen}>
        <KeyboardAvoidingView
          style={s.flex}
          enabled={Platform.OS === 'ios'}
          importantForAccessibility={confirming ? 'no-hide-descendants' : 'auto'}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={s.detailToolbar}>
            <IconButton name="close" label="Close new note" onPress={close} disabled={saving} />
            <Text style={[s.toolbarHeading, s.flex]}>New note</Text>
          </View>
          <View style={s.newIntro}>
            <Text style={s.caption}>Template</Text>
            <ScrollView
              style={{ flexGrow: 0, minHeight: 44 }}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
              keyboardShouldPersistTaps="handled"
            >
              {templates.map((template) => (
                <Pressable
                  key={template.id}
                  accessibilityRole="radio"
                  accessibilityLabel={template.name}
                  accessibilityState={{ selected: template.id === templateId }}
                  disabled={saving}
                  onPress={() => setTemplateId(template.id)}
                  style={[
                    s.templateChip,
                    template.id === templateId && {
                      backgroundColor: colors.accent,
                      borderColor: colors.accent,
                    },
                  ]}
                >
                  <Text
                    style={[
                      s.segmentText,
                      template.id === templateId && { color: colors.onAccent },
                    ]}
                  >
                    {template.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
          {error && (
            <View style={s.errorInset}>
              <ErrorBanner message={error} onDismiss={() => setError(null)} />
            </View>
          )}
          <TextInput
            accessibilityLabel="Note title"
            placeholder="Give it a title"
            placeholderTextColor={colors.muted}
            value={title}
            onChangeText={setTitle}
            editable={!saving}
            maxLength={180}
            style={s.newTitle}
            returnKeyType="next"
          />
          <TextInput
            accessibilityLabel="Note body"
            placeholder="Start anywhere. A sentence, a thought, a possibility…"
            placeholderTextColor={colors.muted}
            value={body}
            onChangeText={setBody}
            editable={!saving}
            multiline
            textAlignVertical="top"
            style={s.newBody}
          />
          <View style={s.createFooter}>
            <Action
              label="Create note"
              busy={saving}
              disabled={!title.trim() || templatesLoading || !templateId}
              icon="add"
              onPress={() => void create()}
            />
            <Text style={[s.caption, { textAlign: 'center' }]}>
              Saved as a .typ file in your folder.
            </Text>
          </View>
        </KeyboardAvoidingView>
        <ConfirmDialog
          visible={confirming}
          title="Leave unsaved changes?"
          message="Your changes haven’t been saved to the notes folder."
          confirmLabel="Discard changes"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            onClose()
          }}
        />
      </View>
    </Screen>
  )
}

function AppearanceSettings({ onClose }: { onClose: () => void }) {
  const s = useStyles()
  const { settings, updateSettings, palette, persistenceError } = useTheme()
  return (
    <Screen onClose={onClose}>
      <View style={s.screen}>
        <View style={s.detailToolbar}>
          <IconButton name="close" label="Close appearance settings" onPress={onClose} />
          <Text style={[s.toolbarHeading, s.flex]}>Appearance</Text>
        </View>
        <ScrollView contentContainerStyle={s.settingsBody}>
          <Text style={s.settingsLabel}>MODE</Text>
          <Segments<AppearanceMode>
            options={[
              { label: 'System', value: 'system' },
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
            ]}
            value={settings.mode}
            onChange={(mode) => updateSettings({ mode })}
          />
          <Text style={s.settingsLabel}>LIGHT PALETTE</Text>
          <View style={s.flavorRow}>
            {lightFlavorNames.map((flavor) => (
              <FlavorOption
                key={flavor}
                flavor={flavor}
                selected={settings.lightFlavor === flavor}
                onPress={() => updateSettings({ lightFlavor: flavor })}
              />
            ))}
          </View>
          <Text style={s.settingsLabel}>DARK PALETTE</Text>
          <View style={s.flavorRow}>
            {darkFlavorNames.map((flavor) => (
              <FlavorOption
                key={flavor}
                flavor={flavor}
                selected={settings.darkFlavor === flavor}
                onPress={() => updateSettings({ darkFlavor: flavor })}
              />
            ))}
          </View>
          <Text style={s.settingsLabel}>ACCENT COLOR</Text>
          <View style={s.accentGrid}>
            {accentNames.map((accent) => {
              const swatch = palette[accent]
              const selected = settings.accent === accent
              return (
                <Pressable
                  key={accent}
                  accessibilityRole="radio"
                  accessibilityLabel={accent}
                  accessibilityState={{ selected }}
                  onPress={() => updateSettings({ accent: accent as Accent })}
                  style={s.accentPressable}
                >
                  <View
                    style={[
                      s.accentSwatch,
                      { backgroundColor: swatch },
                      selected && s.accentSelected,
                    ]}
                  >
                    {selected && (
                      <Icon
                        name="checkmark"
                        size={16}
                        color={luminance(swatch) > 0.179 ? '#000000' : '#ffffff'}
                      />
                    )}
                  </View>
                </Pressable>
              )
            })}
          </View>
          <View style={s.settingRow}>
            <View style={s.flex}>
              <Text style={s.settingTitle}>AMOLED black</Text>
              <Text style={s.caption}>Use pure black in dark mode.</Text>
            </View>
            <Switch
              accessibilityLabel="AMOLED black"
              value={settings.amoled}
              onValueChange={(amoled) => updateSettings({ amoled })}
              trackColor={{ false: palette.surface0, true: palette[settings.accent] }}
              thumbColor={palette.base}
            />
          </View>
          {persistenceError && <Text style={s.errorText}>{persistenceError}</Text>}
        </ScrollView>
      </View>
    </Screen>
  )
}

function FlavorOption({
  flavor,
  selected,
  onPress,
}: {
  flavor: Flavor
  selected: boolean
  onPress: () => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const preview = palettes[flavor]
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${flavor} palette`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        s.flavorOption,
        selected && { borderColor: colors.accent },
        pressed && s.pressed,
      ]}
    >
      <View style={s.flavorSwatches}>
        {[preview.base, preview.mauve, preview.text].map((color) => (
          <View key={color} style={[s.flavorSwatch, { backgroundColor: color }]} />
        ))}
      </View>
      <Text style={[s.flavorText, selected && { color: colors.ink }]}>
        {flavor.charAt(0).toUpperCase() + flavor.slice(1)}
      </Text>
    </Pressable>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    screen: { flex: 1, backgroundColor: colors.paper },
    loadingScreen: {
      flex: 1,
      backgroundColor: colors.paper,
      alignItems: 'center',
      justifyContent: 'center',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 },
    brandLockup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    brandImage: { width: 32, height: 32, borderRadius: 9 },
    dialogRow: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
    },
    dialogRowText: { fontFamily: 'DMSans_600SemiBold', fontSize: 14, color: colors.ink },
    brandMark: {
      width: 30,
      height: 30,
      borderRadius: 10,
      backgroundColor: colors.ink,
      justifyContent: 'center',
      alignItems: 'center',
    },
    markText: {
      fontFamily: 'Newsreader_400Regular',
      color: colors.sage,
      fontSize: 24,
      lineHeight: 28,
    },
    brand: { fontFamily: 'DMSans_600SemiBold', color: colors.ink, fontSize: 22, letterSpacing: -1 },
    folderButton: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'center',
      flexShrink: 1,
      maxWidth: 170,
      gap: 6,
      minHeight: 40,
      paddingHorizontal: 8,
      borderRadius: 12,
      backgroundColor: colors.soft,
    },
    folderName: { fontFamily: 'DMSans_400Regular', fontSize: 14, color: colors.ink, flexShrink: 1 },
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: 16,
      backgroundColor: colors.accent,
      paddingVertical: 12,
      paddingHorizontal: 20,
      minHeight: 48,
    },
    actionText: { fontFamily: 'DMSans_600SemiBold', color: colors.onAccent, fontSize: 14 },
    iconButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 14,
    },
    pressed: { opacity: 0.66 },
    disabled: { opacity: 0.42 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
    muted: { fontFamily: 'DMSans_400Regular', fontSize: 14, color: colors.muted },
    inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    errorInset: { paddingHorizontal: 24, paddingVertical: 8 },
    error: {
      backgroundColor: colors.coralSoft,
      borderRadius: 14,
      padding: 13,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
    },
    errorText: {
      flex: 1,
      color: colors.coral,
      fontSize: 14,
      lineHeight: 20,
      fontFamily: 'DMSans_400Regular',
    },
    onboarding: {
      flexGrow: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      paddingTop: 32,
      paddingBottom: 32,
    },
    illustration: {
      width: 250,
      height: 240,
      marginBottom: 29,
      alignItems: 'center',
      justifyContent: 'center',
    },
    paperBack: {
      position: 'absolute',
      width: 176,
      height: 208,
      backgroundColor: colors.soft,
      borderRadius: 8,
      transform: [{ rotate: '-10deg' }],
      left: 32,
      top: 14,
    },
    paperFront: {
      width: 178,
      height: 211,
      backgroundColor: colors.white,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 7,
      paddingHorizontal: 19,
      paddingTop: 25,
      transform: [{ rotate: '5deg' }],
    },
    paperSource: {
      fontFamily: 'monospace',
      fontSize: 6,
      lineHeight: 8,
      color: colors.ink,
    },
    penBadge: {
      position: 'absolute',
      bottom: 1,
      right: 8,
      backgroundColor: colors.accent,
      borderColor: colors.paper,
      borderWidth: 6,
      width: 65,
      height: 65,
      borderRadius: 32,
      alignItems: 'center',
      justifyContent: 'center',
      transform: [{ rotate: '-10deg' }],
    },
    eyebrow: {
      fontFamily: 'DMSans_600SemiBold',
      color: colors.muted,
      fontSize: 12,
      letterSpacing: 1.2,
    },
    welcomeTitle: {
      fontFamily: 'Newsreader_400Regular',
      color: colors.ink,
      textAlign: 'center',
      fontSize: 36,
      lineHeight: 40,
      letterSpacing: -0.9,
      marginTop: 17,
      marginBottom: 28,
    },
    libraryTop: { paddingHorizontal: 24, paddingTop: 18 },
    search: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.soft,
      borderRadius: 16,
      paddingLeft: 15,
      minHeight: 52,
      paddingRight: 5,
    },
    searchInput: {
      flex: 1,
      color: colors.ink,
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      paddingHorizontal: 10,
      paddingVertical: 12,
    },
    segments: {
      flexDirection: 'row',
      padding: 4,
      backgroundColor: colors.soft,
      borderRadius: 13,
      gap: 3,
    },
    segment: {
      flex: 1,
      minHeight: 44,
      paddingVertical: 12,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    segmentActive: { backgroundColor: colors.white },
    segmentText: { fontFamily: 'DMSans_400Regular', fontSize: 14, color: colors.muted },
    segmentTextActive: { color: colors.ink, fontFamily: 'DMSans_600SemiBold' },
    listMeta: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 12,
      marginBottom: 4,
      height: 44,
    },
    list: { paddingHorizontal: 24, paddingBottom: 106 },
    emptyList: { flexGrow: 1 },
    noteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 20,
      borderBottomColor: colors.line,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    rowPressed: { backgroundColor: colors.soft },
    noteGlyph: {
      width: 39,
      height: 45,
      borderRadius: 11,
      backgroundColor: colors.soft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    noteInfo: { flex: 1, gap: 5 },
    noteTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 18,
      color: colors.ink,
      lineHeight: 24,
      letterSpacing: -0.3,
    },
    notePath: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      color: colors.muted,
      lineHeight: 20,
    },
    snippet: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 18,
      color: colors.muted,
      marginTop: 3,
    },
    fab: {
      position: 'absolute',
      right: 24,
      bottom: 24,
      borderRadius: 19,
      paddingHorizontal: 20,
      minHeight: 56,
      backgroundColor: colors.accent,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      elevation: 3,
      shadowColor: colors.ink,
      shadowOpacity: 0.08,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
    },
    fabText: { fontFamily: 'DMSans_600SemiBold', fontSize: 14, color: colors.onAccent },
    empty: { alignItems: 'center', paddingHorizontal: 20, paddingTop: 44, gap: 17 },
    emptyIcon: {
      width: 66,
      height: 66,
      backgroundColor: colors.soft,
      borderRadius: 23,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 4,
    },
    emptyTitle: {
      fontFamily: 'Newsreader_400Regular',
      fontSize: 36,
      lineHeight: 40,
      color: colors.ink,
      textAlign: 'center',
      letterSpacing: -0.5,
    },
    emptyBody: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      lineHeight: 23,
      color: colors.muted,
      textAlign: 'center',
      maxWidth: 310,
    },
    textLink: { padding: 12 },
    linkText: { fontFamily: 'DMSans_600SemiBold', color: colors.ink, fontSize: 14 },
    detailToolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    toolbarTitle: { flex: 1, gap: 3 },
    toolbarHeading: { fontFamily: 'DMSans_600SemiBold', color: colors.ink, fontSize: 18 },
    detailControls: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 24,
      paddingTop: 14,
      paddingBottom: 10,
      gap: 8,
    },
    findBar: {
      marginHorizontal: 20,
      marginBottom: 8,
      borderRadius: 12,
      paddingLeft: 12,
      backgroundColor: colors.soft,
      flexDirection: 'row',
      alignItems: 'center',
    },
    findInput: {
      flex: 1,
      minWidth: 40,
      color: colors.ink,
      fontFamily: 'DMSans_400Regular',
      paddingVertical: 12,
      paddingHorizontal: 8,
      fontSize: 14,
    },
    findCount: { fontSize: 12, color: colors.muted, fontFamily: 'DMSans_400Regular' },
    sourceFooter: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    caption: { fontFamily: 'DMSans_400Regular', fontSize: 12, color: colors.muted, lineHeight: 20 },
    pdf: { flex: 1, width: '100%', backgroundColor: colors.soft },
    pdfEmpty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 30,
      gap: 20,
      paddingBottom: 35,
    },
    outLabel: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6 },
    warning: {
      backgroundColor: colors.coralSoft,
      flexDirection: 'row',
      alignItems: 'center',
      padding: 14,
      gap: 9,
      marginHorizontal: 20,
      marginBottom: 12,
      borderRadius: 12,
    },
    warningText: {
      color: colors.coral,
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 18,
      flex: 1,
    },
    createFooter: {
      paddingHorizontal: 24,
      paddingVertical: 16,
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    templateChip: {
      minHeight: 44,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.soft,
    },
    newIntro: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 12, gap: 12 },
    newHeading: {
      fontFamily: 'Newsreader_400Regular',
      color: colors.ink,
      fontSize: 36,
      lineHeight: 40,
      letterSpacing: -0.8,
    },
    newTitle: {
      marginHorizontal: 24,
      paddingVertical: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
      fontFamily: 'Newsreader_400Regular',
      fontSize: 18,
      color: colors.ink,
    },
    newBody: {
      flex: 1,
      paddingHorizontal: 24,
      paddingVertical: 24,
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      lineHeight: 24,
      color: colors.ink,
    },
    dialogOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    dialogCard: {
      width: '100%',
      maxWidth: 360,
      backgroundColor: colors.paper,
      borderRadius: 20,
      padding: 20,
      gap: 10,
    },
    dialogTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 18,
      lineHeight: 24,
      color: colors.ink,
    },
    dialogMessage: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      lineHeight: 21,
      color: colors.muted,
    },
    dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
    dialogCancel: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: colors.soft,
    },
    dialogCancelText: { fontFamily: 'DMSans_600SemiBold', fontSize: 14, color: colors.ink },
    dialogConfirm: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: colors.coral,
    },
    dialogConfirmText: { fontFamily: 'DMSans_600SemiBold', fontSize: 14, color: colors.paper },
    settingsBody: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 48, gap: 14 },
    settingsLabel: {
      fontFamily: 'DMSans_600SemiBold',
      color: colors.muted,
      fontSize: 12,
      letterSpacing: 1.2,
      marginTop: 8,
    },
    flavorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    flavorOption: {
      flex: 1,
      minWidth: 70,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 14,
      padding: 10,
      gap: 8,
      alignItems: 'center',
      backgroundColor: colors.soft,
    },
    flavorSwatches: { flexDirection: 'row', gap: 3 },
    flavorSwatch: { width: 14, height: 22, borderRadius: 5 },
    flavorText: { fontFamily: 'DMSans_400Regular', fontSize: 12, color: colors.muted },
    accentGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    accentPressable: { padding: 2, borderRadius: 20 },
    accentSwatch: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: 'transparent',
    },
    accentSelected: { borderColor: colors.ink },
    settingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
      marginTop: 8,
    },
    settingTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 14,
      color: colors.ink,
    },
  })
}

function useStyles() {
  const { colors } = useTheme()
  return useMemo(() => makeStyles(colors), [colors])
}
