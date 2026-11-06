import { MaterialCommunityIcons } from '@expo/vector-icons'
import { DMSans_400Regular, DMSans_600SemiBold, useFonts } from '@expo-google-fonts/dm-sans'
import { Newsreader_400Regular, Newsreader_400Regular_Italic } from '@expo-google-fonts/newsreader'
import * as Sharing from 'expo-sharing'
import * as SplashScreen from 'expo-splash-screen'
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
  Animated,
  AppState,
  BackHandler,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  Vibration,
  View,
} from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Reanimated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context'
import { appCommit, appVersion, commitUrl, issuesUrl, repositoryUrl } from './src/about'
import { BackGate } from './src/back-gate'
import { type CompilerHandle, CompilerHost } from './src/CompilerHost'
import type { PdfWorkspace } from './src/compiler/workspace'
import { DEFAULT_TEMPLATE, foldersFromNotes, isRootTemplate, reconcileNotes } from './src/core'
import { loadFavorites, storeFavorites } from './src/favorites'
import { loadVaultIndex, storeVaultIndex } from './src/library-cache'
import { TypoMark } from './src/Mark'
import { NoteSearch } from './src/NoteSearch'
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
  createFolder,
  createNote,
  loadSavedVault,
  moveFolderToFolder,
  moveNoteToFolder,
  type NoteFolder,
  pickVault,
  preparePdf,
  prepareSource,
  readNote,
  readTemplate,
  saveNote,
  saveTemplate,
  scanVaultLibrary,
  trashFolder,
  trashNote,
} from './src/vault'
import { webRuntime } from './src/web-runtime'

const fonts = {
  DMSans_400Regular,
  DMSans_600SemiBold,
  Newsreader_400Regular,
  Newsreader_400Regular_Italic,
}
// Keep the native launch screen up until the first themed frame is ready, then fade it out.
void SplashScreen.preventAutoHideAsync()
SplashScreen.setOptions({ duration: 250, fade: true })
type NoteSession = SearchResult & { session: number; opening?: boolean; openError?: string }
type FolderEntry = { path: string; name: string }
type LibraryNotice = {
  id: number
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']
  title: string
  body?: string
}
type LibraryItem =
  | { kind: 'folder'; path: string; name: string }
  | { kind: 'note'; result: SearchResult }
type MovingItem = { kind: 'note'; result: SearchResult } | { kind: 'folder'; entry: FolderEntry }
type RowAction = 'favorite' | 'trash'
const warmNote: Note = { uri: '', path: '', title: '', source: '', modifiedAt: null }
const SWIPE_ACTION_WIDTH = 120
const SWIPE_TRASH_DISTANCE = SWIPE_ACTION_WIDTH + 36
const SWIPE_FAVORITE_DISTANCE = SWIPE_ACTION_WIDTH + 36
const SWIPE_TOSS = 0.05
const SWIPE_SPRING = { damping: 26, mass: 0.7, overshootClamping: true, stiffness: 330 }
const AUTO_SAVE_DELAY = 600

function parentFolder(path: string): string {
  const end = path.lastIndexOf('/')
  return end === -1 ? '' : path.slice(0, end)
}

function folderName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.'

const templateTokens =
  /(\{\{(?:title|body)\}\})|(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|(#(?:let|set|show|import|include|if|else|for|in|while|return|break|continue)\b)|(#\p{L}[\p{L}\p{N}_-]*)|(\b\d+(?:\.\d+)?(?:pt|em|cm|mm|in|fr|%)?\b)|(^=+.*$)/gmu

type TemplateTokenColors = {
  placeholder: string
  comment: string
  string: string
  keyword: string
  function: string
  number: string
  heading: string
}

function templateSpans(source: string, colors: TemplateTokenColors) {
  const spans: { from: number; text: string; color?: string }[] = []
  let last = 0
  for (const match of source.matchAll(templateTokens)) {
    const index = match.index ?? 0
    if (index > last) spans.push({ from: last, text: source.slice(last, index) })
    let color: string | undefined
    if (match[1]) color = colors.placeholder
    else if (match[2]) color = colors.comment
    else if (match[3]) color = colors.string
    else if (match[4]) color = colors.keyword
    else if (match[5]) color = colors.function
    else if (match[6]) color = colors.number
    else if (match[7]) color = colors.heading
    spans.push({ from: index, text: match[0], color })
    last = index + match[0].length
  }
  if (last < source.length) spans.push({ from: last, text: source.slice(last) })
  return spans
}

function Icon({
  name,
  size = 21,
  color,
}: {
  name: React.ComponentProps<typeof MaterialCommunityIcons>['name']
  size?: number
  color?: string
}) {
  const { colors } = useTheme()
  return (
    <MaterialCommunityIcons
      accessible={false}
      name={name}
      size={size}
      color={color ?? colors.ink}
    />
  )
}
function IconButton({
  name,
  label,
  onPress,
  disabled = false,
}: {
  name: React.ComponentProps<typeof MaterialCommunityIcons>['name']
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
  icon?: React.ComponentProps<typeof MaterialCommunityIcons>['name']
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
function ErrorBanner({
  message,
  title,
  onDismiss,
}: {
  message: string
  title?: string
  onDismiss?: () => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  return (
    <View accessibilityLiveRegion="polite" style={s.error}>
      <Icon name="alert-circle-outline" color={colors.coral} />
      <View style={s.flex}>
        {title && <Text style={s.errorTitle}>{title}</Text>}
        <ScrollView style={s.errorDetails} nestedScrollEnabled>
          <Text selectable style={[s.errorText, { color: colors.ink }]}>
            {message}
          </Text>
        </ScrollView>
      </View>
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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <AppShell loaded={loaded || !!fontError} />
        </SafeAreaProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  )
}

function AppShell({ loaded }: { loaded: boolean }) {
  const { colors, isDark, ready } = useTheme()
  const launched = loaded && ready
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.paper).catch(() => {})
  }, [colors.paper])
  useEffect(() => {
    if (!ready) return
    const frame = requestAnimationFrame(() => void SplashScreen.hideAsync())
    return () => cancelAnimationFrame(frame)
  }, [ready])
  return (
    <>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      {launched ? <Library /> : <LaunchScreen />}
    </>
  )
}

function LaunchScreen() {
  const s = useStyles()
  const opacity = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const fade = Animated.timing(opacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    })
    fade.start()
    return () => fade.stop()
  }, [opacity])
  return (
    <View style={s.launchScreen}>
      <Animated.View style={{ opacity }}>
        <TypoMark size={120} />
      </Animated.View>
    </View>
  )
}

function Library() {
  const s = useStyles()
  const { top, right, bottom, left } = useSafeAreaInsets()
  const { colors, palette } = useTheme()
  const [vault, setVault] = useState<Vault | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [folders, setFolders] = useState<string[]>([''])
  const [folder, setFolder] = useState('')
  const [restoring, setRestoring] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<{ uri: string; message: string } | null>(null)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('names')
  const [selected, setSelected] = useState<NoteSession | null>(null)
  const [prepared, setPrepared] = useState<NoteSession | null>(null)
  const [paintedSession, setPaintedSession] = useState(0)
  const pendingNote = useRef<NoteSession | null>(null)
  const openingScreen = useRef<'note' | 'new' | 'move' | 'appearance' | 'about' | null>(null)
  const libraryVisibleRef = useRef(true)
  const [backGate] = useState(() => new BackGate())
  const backFrame = useRef<number | null>(null)
  const noteSession = useRef(0)
  const openingStarted = useRef<{ session: number; at: number } | null>(null)
  const noticeSession = useRef(0)
  const skippedReport = useRef('')
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  creatingRef.current = creating
  const [moving, setMoving] = useState<MovingItem | null>(null)
  const [notice, setNotice] = useState<LibraryNotice | null>(null)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [favorites, setFavorites] = useState<string[]>([])
  const favoritesReady = useRef(false)
  const [trashing, setTrashing] = useState<string | null>(null)
  const [trashNotice, setTrashNotice] = useState<{ id: number; title: string } | null>(null)
  const trashNoticeId = useRef(0)
  const trashBusy = useRef(false)
  const [templateCache, setTemplateCache] = useState<{ vault: string; source: string } | null>(null)
  const templateVersion = useRef(0)
  const compiler = useRef<CompilerHandle>(null)
  const listRef = useRef<FlatList<LibraryItem>>(null)
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
    const templateVersionAtStart = templateVersion.current
    const started = performance.now()
    let firstBatch = true
    const request = ++generation.current
    scanningRef.current = true
    if (!quiet) {
      setScanning(true)
      setError(null)
    }
    try {
      const result = await scanVaultLibrary(
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
                setFolders(foldersFromNotes(partial))
              }
            }
      )
      if (mounted.current && request === generation.current) {
        setNotes((previous) => reconcileNotes(previous, result.notes))
        setFolders(result.folders)
        if (templateVersion.current === templateVersionAtStart) {
          const templates = result.notes.filter((note) => isRootTemplate(note.path))
          const folder = result.folders.some((path) => path.toLowerCase() === 'template.typ')
          // Leave invalid templates to readTemplate so NewNote reports the error.
          const skippedTemplate = result.skipped.some((path) => isRootTemplate(path))
          if (folder || templates.length > 1 || skippedTemplate) setTemplateCache(null)
          else if (!creatingRef.current)
            setTemplateCache((previous) => {
              const source = templates[0]?.source ?? DEFAULT_TEMPLATE
              return previous?.vault === target.uri && previous.source === source
                ? previous
                : { vault: target.uri, source }
            })
        }
        setError(null)
        const skippedReportKey = `${target.uri}\n${result.skipped.join('\n')}`
        if (skippedReportKey !== skippedReport.current) {
          skippedReport.current = skippedReportKey
          if (result.skipped.length > 0) {
            const count = result.skipped.length
            setNotice({
              id: ++noticeSession.current,
              icon: 'file-alert-outline',
              title: `${count} note${count === 1 ? '' : 's'} could not be read`,
              body: result.skipped.slice(0, 3).join(', '),
            })
          }
        }
        if (__DEV__)
          console.info(
            `[performance] Vault scan: ${result.notes.length} notes in ${Math.round(performance.now() - started)} ms`
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
          setFavorites(await loadFavorites(saved))
          favoritesReady.current = true
          if (cancelled) return
          if (cached) {
            setNotes(cached)
            setFolders(foldersFromNotes(cached))
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
    const target = vaultRef.current
    if (!target || !favoritesReady.current) return
    const timer = setTimeout(() => {
      void storeFavorites(target, favorites).catch(() => {})
    }, 300)
    return () => clearTimeout(timer)
  }, [favorites])

  useEffect(() => {
    const timer = setInterval(quietScan, 15_000)
    return () => clearInterval(timer)
  }, [quietScan])

  useEffect(() => {
    const open = !!selected || creating || !!moving || appearanceOpen || aboutOpen
    if (modalWasOpen.current && !open) quietScan()
    modalWasOpen.current = open
  }, [selected, creating, moving, appearanceOpen, aboutOpen, quietScan])

  async function chooseVault() {
    if (picking || restoring || backGate.blockOpening()) return
    Keyboard.dismiss()
    setPicking(true)
    setError(null)
    setSaveError(null)
    try {
      const next = await pickVault()
      if (!mounted.current || !next) return
      generation.current++
      scanningRef.current = false
      favoritesReady.current = false
      setVault(next)
      vaultRef.current = next
      setNotes([])
      setFolders([''])
      setFavorites([])
      setFolder('')
      setTemplateCache(null)
      setMoving(null)
      setNotice(null)
      setPrepared(null)
      pendingNote.current = null
      openingScreen.current = null
      const cached = await loadVaultIndex(next)
      if (!mounted.current) return
      setNotes(cached || [])
      setFolders(cached ? foldersFromNotes(cached) : [''])
      setFavorites(await loadFavorites(next))
      favoritesReady.current = true
      if (!mounted.current) return
      setQuery('')
      await index(next, { quiet: !!cached })
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setPicking(false)
    }
  }

  const deferredQuery = useDeferredValue(query)
  const [searchResults, setResults] = useState<SearchResult[]>([])
  const [searchPending, setSearchPending] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const searchBusy = searchPending || deferredQuery !== query
  const results = useMemo(() => {
    const current = new Map(notes.map((note) => [note.uri, note]))
    return searchResults.flatMap((result) => {
      const note = current.get(result.note.uri)
      return note ? [{ ...result, note }] : []
    })
  }, [notes, searchResults])
  const isSearching = query.trim().length > 0
  useEffect(() => {
    // Results stay visible while the next search runs, so drop them when search ends.
    if (!isSearching) setResults((current) => (current.length ? [] : current))
  }, [isSearching])
  const [searchFocused, setSearchFocused] = useState(false)
  const showSearchModes = isSearching || searchFocused
  const searchInput = useRef<React.ComponentRef<typeof TextInput>>(null)
  const searchModesReveal = useRef(new Animated.Value(0)).current
  useEffect(() => {
    // Keep focus state in sync with the keyboard so the modes hide when it closes.
    const listener = Keyboard.addListener('keyboardDidHide', () => searchInput.current?.blur())
    return () => listener.remove()
  }, [])
  useEffect(() => {
    searchModesReveal.stopAnimation()
    if (!showSearchModes) {
      searchModesReveal.setValue(0)
      return
    }
    Animated.timing(searchModesReveal, {
      toValue: 1,
      duration: 140,
      useNativeDriver: true,
    }).start()
  }, [showSearchModes, searchModesReveal])
  const currentNotes = useMemo(
    () => notes.filter((note) => parentFolder(note.path) === folder),
    [notes, folder]
  )
  const childFolders = useMemo<FolderEntry[]>(
    () =>
      folders
        .filter((path) => path !== '' && parentFolder(path) === folder)
        .map((path) => ({ path, name: folderName(path) })),
    [folders, folder]
  )
  const favoritePaths = useMemo(() => new Set(favorites), [favorites])
  const libraryItems = useMemo<LibraryItem[]>(() => {
    if (isSearching) return results.map((result) => ({ kind: 'note', result }))
    const items: LibraryItem[] = [
      ...childFolders.map((entry) => ({ kind: 'folder' as const, ...entry })),
      ...currentNotes.map((note) => ({ kind: 'note' as const, result: { note } })),
    ]
    const isFavorite = (item: LibraryItem) =>
      favoritePaths.has(item.kind === 'folder' ? item.path : item.result.note.path)
    return [...items.filter(isFavorite), ...items.filter((item) => !isFavorite(item))]
  }, [isSearching, results, childFolders, currentNotes, favoritePaths])
  const crumbs = useMemo(() => {
    let path = ''
    return folder
      ? folder.split('/').map((name) => {
          path = path ? `${path}/${name}` : name
          return { name, path }
        })
      : []
  }, [folder])
  const folderLabel = folder || 'All notes'
  const goToFolder = useCallback(
    (path: string) => {
      if (backGate.blockOpening()) return
      Keyboard.dismiss()
      listRef.current?.scrollToOffset({ offset: 0, animated: false })
      setFolder(path)
    },
    [backGate]
  )
  const stopIndex = useCallback(() => {
    generation.current++
    scanningRef.current = false
    setScanning(false)
  }, [])
  const toggleFavorite = useCallback((path: string) => {
    setFavorites((previous) =>
      previous.includes(path) ? previous.filter((item) => item !== path) : [...previous, path]
    )
  }, [])
  const moveToTrash = useCallback(
    async (item: MovingItem) => {
      const target = vaultRef.current
      if (!target || trashBusy.current) return
      trashBusy.current = true
      stopIndex()
      setError(null)
      setTrashing(item.kind === 'folder' ? `folder:${item.entry.path}` : item.result.note.uri)
      try {
        if (item.kind === 'folder') {
          const { entry } = item
          const prefix = `${entry.path}/`
          const inside = (path: string) => path === entry.path || path.startsWith(prefix)
          await trashFolder(target, entry.path)
          if (!mounted.current || vaultRef.current?.uri !== target.uri) return
          setNotes((previous) => previous.filter((note) => !inside(note.path)))
          setFolders((previous) => previous.filter((path) => !inside(path)))
          setFavorites((previous) => previous.filter((path) => !inside(path)))
          setPrepared((current) => (current && inside(current.note.path) ? null : current))
          setSelected((current) => (current && inside(current.note.path) ? null : current))
          if (pendingNote.current && inside(pendingNote.current.note.path)) {
            pendingNote.current = null
          }
          setTrashNotice({ id: ++trashNoticeId.current, title: entry.name })
          return
        }
        const { note } = item.result
        await trashNote(target, note)
        if (!mounted.current || vaultRef.current?.uri !== target.uri) return
        if (isRootTemplate(note.path)) {
          templateVersion.current += 1
          setTemplateCache(null)
        }
        setNotes((previous) => previous.filter((item) => item.uri !== note.uri))
        setFavorites((previous) => previous.filter((path) => path !== note.path))
        setPrepared((current) => (current?.note.uri === note.uri ? null : current))
        setSelected((current) => (current?.note.uri === note.uri ? null : current))
        if (pendingNote.current?.note.uri === note.uri) pendingNote.current = null
        setTrashNotice({ id: ++trashNoticeId.current, title: note.title })
      } catch (cause) {
        if (mounted.current) setError(errorText(cause))
      } finally {
        trashBusy.current = false
        if (mounted.current) {
          setTrashing(null)
        }
      }
    },
    [stopIndex]
  )
  const settleBack = useCallback(
    (exit: boolean) => {
      if (!backGate.begin(exit)) return
      // Drain queued touch callbacks before allowing another screen to open.
      backFrame.current = requestAnimationFrame(() => {
        backFrame.current = requestAnimationFrame(() => {
          backFrame.current = null
          if (backGate.finish()) BackHandler.exitApp()
        })
      })
    },
    [backGate]
  )
  useLayoutEffect(() => {
    const cancelOpening = () => {
      if (!openingScreen.current) return false
      openingScreen.current = null
      stopIndex()
      pendingNote.current = null
      setSelected(null)
      setCreating(false)
      setMoving(null)
      setAppearanceOpen(false)
      setAboutOpen(false)
      return true
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!libraryVisibleRef.current) return false
      if (cancelOpening()) settleBack(false)
      else if (query) {
        setQuery('')
        settleBack(false)
      } else if (folder) {
        goToFolder(parentFolder(folder))
        settleBack(false)
      } else settleBack(true)
      return true
    })
    return () => subscription.remove()
  }, [folder, goToFolder, query, settleBack, stopIndex])
  useLayoutEffect(
    () => () => {
      if (backFrame.current !== null) cancelAnimationFrame(backFrame.current)
      backGate.cancel()
    },
    [backGate]
  )
  const prepareNote = useCallback((result: SearchResult) => {
    Keyboard.dismiss()
    const next = { ...result, session: ++noteSession.current }
    openingStarted.current = { session: next.session, at: performance.now() }
    pendingNote.current = next
    setPrepared(next)
    return next
  }, [])
  const editorPrepared = useCallback((session: number) => {
    setPaintedSession(session)
    const started = openingStarted.current
    if (started?.session === session) {
      if (__DEV__)
        console.info(
          `[performance] Note editor ready: ${(performance.now() - started.at).toFixed(1)} ms`
        )
      openingStarted.current = null
    }
  }, [])
  const openNote = useCallback(
    async (result: SearchResult) => {
      if (backGate.blockOpening()) return
      openingScreen.current = 'note'
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
        setNotes((previous) =>
          previous.some((item) => item.uri === note.uri && item !== note)
            ? previous.map((item) => (item.uri === note.uri ? note : item))
            : previous
        )
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
    [backGate, prepareNote, stopIndex]
  )
  const updateNote = (note: Note) => {
    stopIndex()
    if (vault && isRootTemplate(note.path)) {
      templateVersion.current += 1
      setTemplateCache({ vault: vault.uri, source: note.source })
    }
    setNotes((previous) => previous.map((item) => (item.uri === note.uri ? note : item)))
    setPrepared((current) => (current?.note.uri === note.uri ? { ...current, note } : current))
    setSelected((current) =>
      current?.note.uri === note.uri ? { ...current, note, openError: undefined } : current
    )
    setError(null)
    setSaveError((current) => (current?.uri === note.uri ? null : current))
  }
  const showNotice = useCallback(
    (icon: LibraryNotice['icon'], title: string, body?: string) =>
      setNotice({ id: ++noticeSession.current, icon, title, body }),
    []
  )
  const startMove = useCallback(
    (item: MovingItem) => {
      if (backGate.blockOpening()) return
      Keyboard.dismiss()
      openingScreen.current = 'move'
      setMoving(item)
    },
    [backGate]
  )
  const moveTo = useCallback(
    async (destination: string) => {
      const item = moving
      const target = vaultRef.current
      if (!item || !target) throw new Error('This item is no longer available.')
      stopIndex()
      if (item.kind === 'note') {
        const result = item.result
        const moved = await moveNoteToFolder(target, result.note, destination)
        if (!mounted.current) return
        if (isRootTemplate(result.note.path) || isRootTemplate(moved.path)) {
          templateVersion.current += 1
          setTemplateCache(null)
        }
        setNotes((previous) =>
          previous
            .map((item) => (item.uri === result.note.uri ? moved : item))
            .sort((a, b) => a.path.localeCompare(b.path))
        )
        setFavorites((previous) =>
          previous.map((path) => (path === result.note.path ? moved.path : path))
        )
        setPrepared((current) => (current?.note.uri === result.note.uri ? null : current))
        setSelected((current) => (current?.note.uri === result.note.uri ? null : current))
        if (pendingNote.current?.note.uri === result.note.uri) pendingNote.current = null
        openingScreen.current = null
        setMoving(null)
        showNotice('folder-open-outline', 'Note moved', moved.path)
        return
      }
      const entry = item.entry
      const moved = await moveFolderToFolder(target, entry.path, destination)
      if (!mounted.current) return
      const prefix = `${entry.path}/`
      const inside = (path: string) => path === entry.path || path.startsWith(prefix)
      const shifted = (path: string) => `${moved.path}${path.slice(entry.path.length)}`
      const renamed = new Map(moved.notes.map((note) => [note.uri, note.nextUri]))
      setNotes((previous) =>
        previous
          .map((note) =>
            inside(note.path)
              ? {
                  ...note,
                  uri: renamed.get(note.uri) ?? note.uri,
                  path: shifted(note.path),
                  pdfUri: undefined,
                  pdfHash: undefined,
                }
              : note
          )
          .sort((a, b) => a.path.localeCompare(b.path))
      )
      setFolders((previous) =>
        previous
          .map((path) => (inside(path) ? shifted(path) : path))
          .sort((a, b) => a.localeCompare(b))
      )
      setFavorites((previous) => previous.map((path) => (inside(path) ? shifted(path) : path)))
      setPrepared((current) => (current && inside(current.note.path) ? null : current))
      setSelected((current) => (current && inside(current.note.path) ? null : current))
      if (pendingNote.current && inside(pendingNote.current.note.path)) pendingNote.current = null
      openingScreen.current = null
      setMoving(null)
      showNotice('folder-open-outline', 'Folder moved', moved.path)
    },
    [moving, showNotice, stopIndex]
  )
  const folderCreated = useCallback((created: NoteFolder) => {
    setFolders((previous) =>
      previous.includes(created.path)
        ? previous
        : [...previous, created.path].sort((a, b) => a.localeCompare(b))
    )
  }, [])
  const startMoveNote = useCallback(
    (result: SearchResult) => startMove({ kind: 'note', result }),
    [startMove]
  )
  const startMoveFolder = useCallback(
    (entry: FolderEntry) => startMove({ kind: 'folder', entry }),
    [startMove]
  )
  const trashNoteItem = useCallback(
    (result: SearchResult) => moveToTrash({ kind: 'note', result }),
    [moveToTrash]
  )
  const trashFolderItem = useCallback(
    (entry: FolderEntry) => moveToTrash({ kind: 'folder', entry }),
    [moveToTrash]
  )
  const favoriteNoteItem = useCallback(
    (result: SearchResult) => toggleFavorite(result.note.path),
    [toggleFavorite]
  )
  const favoriteFolderItem = useCallback(
    (entry: FolderEntry) => toggleFavorite(entry.path),
    [toggleFavorite]
  )

  const { workspace, errors: pdfErrors } = usePdfWorkspace({
    vault,
    notes,
    enabled: !restoring && !scanning && !picking,
    compiler,
  })

  useEffect(() => {
    if (!vault) {
      setTemplateCache(null)
      return
    }
    void webRuntime('editor').catch(() => {})
  }, [vault])

  useEffect(() => {
    if (!vault || restoring || scanning) return
    const timer = setTimeout(() => {
      void webRuntime('pdf').catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [vault, restoring, scanning])

  const detail = selected ?? prepared
  const noteVisible = !!selected && selected.session === paintedSession
  const libraryVisible = !noteVisible && !creating && !moving && !appearanceOpen && !aboutOpen
  useLayoutEffect(() => {
    libraryVisibleRef.current = libraryVisible
  }, [libraryVisible])
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="About Typo"
            onPress={() => {
              if (backGate.blockOpening()) return
              Keyboard.dismiss()
              openingScreen.current = 'about'
              setAboutOpen(true)
            }}
            style={({ pressed }) => [s.brandLockup, pressed && s.pressed]}
          >
            <TypoMark size={32} />
            <Text style={s.brand}>Typo</Text>
          </Pressable>
          <View style={s.headerRight}>
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
                <Icon name="swap-horizontal" size={16} color={colors.muted} />
              </Pressable>
            )}
            <IconButton
              name="palette-outline"
              label="Appearance settings"
              onPress={() => {
                if (backGate.blockOpening()) return
                Keyboard.dismiss()
                openingScreen.current = 'appearance'
                setAppearanceOpen(true)
              }}
            />
          </View>
        </View>
        {(error || saveError) && (
          <View style={s.errorInset}>
            {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
            {saveError && (
              <ErrorBanner message={saveError.message} onDismiss={() => setSaveError(null)} />
            )}
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
                <Icon name="magnify" color={colors.muted} />
                <TextInput
                  ref={searchInput}
                  accessibilityLabel="Search notes"
                  placeholder="Find a thought…"
                  placeholderTextColor={colors.muted}
                  value={query}
                  onChangeText={(value) => {
                    setQuery(value)
                  }}
                  style={s.searchInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  onPressIn={() => setSearchFocused(true)}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                />
                {query.length > 0 && (
                  <IconButton
                    name="close-circle"
                    label="Clear search"
                    onPress={() => {
                      setQuery('')
                    }}
                  />
                )}
              </View>
              {showSearchModes && (
                <Animated.View
                  style={{
                    marginTop: 12,
                    opacity: searchModesReveal,
                    transform: [
                      {
                        translateY: searchModesReveal.interpolate({
                          inputRange: [0, 1],
                          outputRange: [-8, 0],
                        }),
                      },
                    ],
                  }}
                >
                  <Segments
                    options={[
                      { label: 'Names', value: 'names' },
                      { label: 'Content', value: 'content' },
                      { label: 'Everywhere', value: 'all' },
                    ]}
                    value={mode}
                    onChange={(value) => {
                      setMode(value)
                    }}
                  />
                </Animated.View>
              )}
              {!isSearching && folder !== '' && (
                <View style={s.crumbs}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Go to ${vault?.name || 'notes folder'} root`}
                    onPress={() => goToFolder('')}
                    style={({ pressed }) => [s.crumbRoot, pressed && s.pressed]}
                  >
                    <Icon name="home-outline" size={17} />
                  </Pressable>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={s.crumbScroll}
                  >
                    {crumbs.map((crumb, index) => (
                      <View key={crumb.path} style={s.crumbGroup}>
                        <Icon name="chevron-right" size={13} color={colors.muted} />
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Open folder ${crumb.path}`}
                          accessibilityState={{ selected: index === crumbs.length - 1 }}
                          disabled={index === crumbs.length - 1}
                          onPress={() => goToFolder(crumb.path)}
                          style={({ pressed }) => [s.crumbButton, pressed && s.pressed]}
                        >
                          <Text
                            numberOfLines={1}
                            style={[s.crumbText, index === crumbs.length - 1 && s.crumbCurrent]}
                          >
                            {crumb.name}
                          </Text>
                        </Pressable>
                      </View>
                    ))}
                  </ScrollView>
                </View>
              )}
              {(isSearching || pdfErrors > 0) && (
                <View style={[s.listMeta, !isSearching && s.listMetaEnd]}>
                  {isSearching ? (
                    <Text accessibilityLiveRegion="polite" style={s.eyebrow}>
                      {searchBusy
                        ? 'SEARCHING…'
                        : `${results.length} RESULT${results.length === 1 ? '' : 'S'}`}
                    </Text>
                  ) : null}
                  {pdfErrors > 0 ? (
                    <Text accessibilityLiveRegion="polite" style={s.muted}>
                      {pdfErrors} note{pdfErrors === 1 ? '' : 's'} could not be compiled
                    </Text>
                  ) : null}
                </View>
              )}
            </View>
            <FlatList
              ref={listRef}
              bounces={false}
              alwaysBounceVertical={false}
              overScrollMode="never"
              initialNumToRender={12}
              maxToRenderPerBatch={16}
              updateCellsBatchingPeriod={16}
              data={libraryItems}
              keyExtractor={(item) =>
                item.kind === 'folder' ? `folder:${item.path}` : `note:${item.result.note.uri}`
              }
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              extraData={`${trashing ?? ''}:${favorites.length}`}
              contentContainerStyle={[s.list, libraryItems.length === 0 && s.emptyList]}
              renderItem={({ item }) =>
                item.kind === 'folder' ? (
                  <FolderRow
                    entry={item}
                    busy={trashing === `folder:${item.path}`}
                    favorite={favoritePaths.has(item.path)}
                    onPress={goToFolder}
                    onLongPress={startMoveFolder}
                    onToggleFavorite={favoriteFolderItem}
                    onTrash={trashFolderItem}
                  />
                ) : (
                  <NoteRow
                    result={item.result}
                    busy={trashing === item.result.note.uri}
                    favorite={favoritePaths.has(item.result.note.path)}
                    onPressIn={prepareNote}
                    onPress={openNote}
                    onLongPress={startMoveNote}
                    onToggleFavorite={favoriteNoteItem}
                    onTrash={trashNoteItem}
                  />
                )
              }
              ListHeaderComponent={
                !isSearching && folder !== '' ? (
                  <ParentFolderRow
                    label={folderLabel}
                    parentName={
                      parentFolder(folder)
                        ? folderName(parentFolder(folder))
                        : vault?.name || 'Notes'
                    }
                    onPress={() => goToFolder(parentFolder(folder))}
                  />
                ) : undefined
              }
              ListEmptyComponent={
                !scanning && !searchBusy ? (
                  <View style={s.empty}>
                    <View style={s.emptyIcon}>
                      <Icon
                        name={
                          isSearching
                            ? 'magnify'
                            : folder
                              ? 'folder-open-outline'
                              : 'file-document-outline'
                        }
                        size={28}
                      />
                    </View>
                    <Text style={s.emptyTitle}>
                      {isSearching
                        ? searchFailed
                          ? 'Search failed.'
                          : 'No notes found.'
                        : folder
                          ? 'This folder is empty.'
                          : 'A fresh page awaits.'}
                    </Text>
                    {!isSearching && (
                      <Text style={s.emptyBody}>
                        {folder
                          ? 'Write a note here, or add .typ files to this folder.'
                          : 'Create your first note, or add .typ files to this folder. They’ll feel right at home.'}
                      </Text>
                    )}
                    {isSearching ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => {
                          setQuery('')
                        }}
                        style={s.textLink}
                      >
                        <Text style={s.linkText}>Clear search</Text>
                      </Pressable>
                    ) : (
                      <Action
                        label={folder ? 'Write a note here' : 'Write your first note'}
                        icon="plus"
                        onPress={() => {
                          if (backGate.blockOpening()) return
                          stopIndex()
                          openingScreen.current = 'new'
                          setCreating(true)
                        }}
                      />
                    )}
                  </View>
                ) : undefined
              }
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create a new note"
              onPress={() => {
                if (backGate.blockOpening()) return
                Keyboard.dismiss()
                setNotice(null)
                stopIndex()
                openingScreen.current = 'new'
                setCreating(true)
              }}
              onPressIn={Keyboard.dismiss}
              style={({ pressed }) => [s.fab, pressed && s.pressed]}
            >
              <Icon name="plus" size={23} color={colors.onAccent} />
              <Text style={s.fabText}>New note</Text>
            </Pressable>
            {trashNotice && (
              <TrashNotice
                key={trashNotice.id}
                title={trashNotice.title}
                onDone={() => setTrashNotice(null)}
              />
            )}
            {notice && (
              <LibraryNotice key={notice.id} notice={notice} onDone={() => setNotice(null)} />
            )}
          </>
        )}
      </View>
      {vault && (
        <NoteSearch
          key={`search:${vault.uri}`}
          notes={notes}
          query={deferredQuery}
          mode={mode}
          onResults={(results) => {
            setResults(results)
            setSearchFailed(false)
          }}
          onError={(message) => {
            setResults([])
            setSearchFailed(true)
            setError(message)
          }}
          onPending={setSearchPending}
        />
      )}
      {workspace && <CompilerHost key={vault?.uri} ref={compiler} />}
      {vault && workspace && (
        <NoteDetail
          key={`detail:${vault.uri}`}
          workspace={workspace}
          active={noteVisible}
          onPrepared={editorPrepared}
          session={detail?.session ?? 0}
          note={detail?.note ?? warmNote}
          opening={!!selected?.opening}
          openError={selected?.openError}
          initialLine={detail?.line}
          initialQuery={isSearching && detail?.line ? query : ''}
          onClose={() => {
            settleBack(false)
            openingScreen.current = null
            stopIndex()
            pendingNote.current = null
            setSelected(null)
          }}
          onSave={updateNote}
          onSaveError={(message) => setSaveError({ uri: detail?.note.uri ?? '', message })}
        />
      )}
      {creating && vault && (
        <NewNote
          vault={vault}
          folders={folders}
          directory={folder}
          initialTemplate={templateCache?.vault === vault.uri ? templateCache.source : undefined}
          onFolderCreated={folderCreated}
          onTemplateSaved={(source) => {
            templateVersion.current += 1
            setTemplateCache({ vault: vault.uri, source })
            void index(vault, { quiet: true })
          }}
          onClose={() => {
            settleBack(false)
            openingScreen.current = null
            setCreating(false)
          }}
          onCreated={(note) => {
            stopIndex()
            setNotes((previous) => [...previous, note].sort((a, b) => a.path.localeCompare(b.path)))
            setQuery('')
            setCreating(false)
            openingScreen.current = 'note'
            setSelected(prepareNote({ note }))
          }}
        />
      )}
      {moving && vault && (
        <FolderSheet
          folders={folders}
          vault={vault}
          initial={null}
          exclude={parentFolder(
            moving.kind === 'note' ? moving.result.note.path : moving.entry.path
          )}
          excludeTree={moving.kind === 'folder' ? moving.entry.path : undefined}
          defaultParent={moving.kind === 'folder' ? parentFolder(moving.entry.path) : folder}
          title={moving.kind === 'folder' ? 'Move folder' : 'Move note'}
          confirmLabel="Move here"
          busyLabel="Moving…"
          onConfirm={moveTo}
          onFolderCreated={folderCreated}
          onClose={() => {
            settleBack(false)
            openingScreen.current = null
            setMoving(null)
          }}
        />
      )}
      {aboutOpen && (
        <AboutSheet
          onClose={() => {
            settleBack(false)
            openingScreen.current = null
            setAboutOpen(false)
          }}
        />
      )}
      {appearanceOpen && (
        <AppearanceSettings
          onClose={() => {
            settleBack(false)
            openingScreen.current = null
            setAppearanceOpen(false)
          }}
        />
      )}
    </View>
  )
}

function SwipeRow({
  busy,
  favorite,
  noun,
  label,
  onPressIn,
  onPress,
  onLongPress,
  onToggleFavorite,
  onTrash,
  children,
}: {
  busy: boolean
  favorite: boolean
  noun: 'note' | 'folder'
  label: string
  onPressIn?: () => void
  onPress: () => void
  onLongPress: () => void
  onToggleFavorite: () => void
  onTrash: () => void
  children: React.ReactNode
}) {
  const s = useStyles()
  const { colors, isDark } = useTheme()
  const translation = useSharedValue(0)
  const start = useSharedValue(0)
  const side = useSharedValue<RowAction | null>(null)
  const swiped = useRef(false)
  const longPressed = useRef(false)
  const paneRef = useRef<RowAction | null>(null)
  const [pane, setPane] = useState<RowAction | null>(null)
  const [armed, setArmed] = useState<RowAction | null>(null)
  const live = useRef({
    busy,
    onPressIn,
    onPress,
    onLongPress,
    onToggleFavorite,
    onTrash,
  })
  live.current = {
    busy,
    onPressIn,
    onPress,
    onLongPress,
    onToggleFavorite,
    onTrash,
  }
  const showPane = useCallback((next: RowAction | null) => {
    if (paneRef.current === next) return
    paneRef.current = next
    setPane(next)
  }, [])
  const hidePane = useCallback(() => {
    paneRef.current = null
    setPane(null)
  }, [])
  const markSwiped = useCallback(() => {
    swiped.current = true
  }, [])
  const vibrate = useCallback(() => Vibration.vibrate(10), [])
  useAnimatedReaction(
    () =>
      translation.value <= -SWIPE_TRASH_DISTANCE
        ? 'trash'
        : translation.value >= SWIPE_FAVORITE_DISTANCE
          ? 'favorite'
          : null,
    (current, previous) => {
      if (current === previous) return
      runOnJS(setArmed)(current)
      if (current) runOnJS(vibrate)()
    }
  )
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-4, 4])
        .failOffsetY([-20, 20])
        .enabled(!busy)
        .onStart(() => {
          'worklet'
          start.value = translation.value
          side.value = null
          runOnJS(markSwiped)()
        })
        .onUpdate((event) => {
          'worklet'
          let locked = side.value
          if (!locked) {
            if (event.translationX === 0) return
            locked = event.translationX < 0 ? 'trash' : 'favorite'
            side.value = locked
            runOnJS(showPane)(locked)
          }
          const raw = start.value + event.translationX
          translation.value =
            locked === 'favorite'
              ? raw > SWIPE_FAVORITE_DISTANCE
                ? SWIPE_FAVORITE_DISTANCE + Math.min(14, (raw - SWIPE_FAVORITE_DISTANCE) * 0.12)
                : raw < 0
                  ? raw * 0.12
                  : raw
              : raw < -SWIPE_TRASH_DISTANCE
                ? -SWIPE_TRASH_DISTANCE + Math.max(-14, (raw + SWIPE_TRASH_DISTANCE) * 0.12)
                : raw > 0
                  ? raw * 0.12
                  : raw
        })
        .onEnd((event, success) => {
          'worklet'
          if (!success) return
          const locked = side.value
          if (locked) {
            const projected = start.value + event.translationX + event.velocityX * SWIPE_TOSS
            if (locked === 'trash' && projected <= -SWIPE_TRASH_DISTANCE) {
              runOnJS(onTrash)()
            } else if (locked === 'favorite' && projected >= SWIPE_FAVORITE_DISTANCE) {
              runOnJS(onToggleFavorite)()
            }
          }
          translation.value = withSpring(0, SWIPE_SPRING, (finished) => {
            'worklet'
            if (finished) runOnJS(hidePane)()
          })
        })
        .onFinalize((_event, success) => {
          'worklet'
          if (!success) {
            translation.value = withSpring(0, SWIPE_SPRING, (finished) => {
              'worklet'
              if (finished) runOnJS(hidePane)()
            })
          }
          side.value = null
        }),
    [busy, hidePane, markSwiped, onToggleFavorite, onTrash, showPane, side, start, translation]
  )
  const trashPaneStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          translation.value,
          [-SWIPE_ACTION_WIDTH, 0],
          [0, SWIPE_ACTION_WIDTH],
          Extrapolation.CLAMP
        ),
      },
    ],
  }))
  const favoritePaneStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          translation.value,
          [0, SWIPE_ACTION_WIDTH],
          [-SWIPE_ACTION_WIDTH, 0],
          Extrapolation.CLAMP
        ),
      },
    ],
  }))
  const trashContentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      translation.value,
      [-SWIPE_ACTION_WIDTH, -SWIPE_ACTION_WIDTH * 0.2, 0],
      [1, 0.35, 0],
      Extrapolation.CLAMP
    ),
    transform: [
      {
        scale: interpolate(
          translation.value,
          [-SWIPE_TRASH_DISTANCE, -SWIPE_ACTION_WIDTH, 0],
          [1.12, 1, 0.86],
          Extrapolation.CLAMP
        ),
      },
    ],
  }))
  const favoriteContentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      translation.value,
      [0, SWIPE_ACTION_WIDTH * 0.2, SWIPE_ACTION_WIDTH],
      [0, 0.35, 1],
      Extrapolation.CLAMP
    ),
    transform: [
      {
        scale: interpolate(
          translation.value,
          [0, SWIPE_ACTION_WIDTH, SWIPE_FAVORITE_DISTANCE],
          [0.86, 1, 1.12],
          Extrapolation.CLAMP
        ),
      },
    ],
  }))
  const press = () => {
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    if (swiped.current) {
      swiped.current = false
      return
    }
    if (live.current.busy) return
    live.current.onPress()
  }
  const hint = `Swipe right and release to favorite this ${noun}, or swipe left and release to move it to trash.`
  return (
    <View style={[s.swipeShell, pane !== null && s.swipeClipped]}>
      <GestureDetector gesture={pan}>
        <View style={s.swipeForeground} renderToHardwareTextureAndroid>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={`${hint} Long press to move this ${noun}.`}
            accessibilityState={{ busy }}
            accessibilityActions={[
              { name: 'favorite', label: favorite ? 'Remove from favorites' : 'Add to favorites' },
              { name: 'trash', label: 'Move to trash' },
              { name: 'move', label: 'Move to folder' },
            ]}
            onAccessibilityAction={(event) => {
              const action = event.nativeEvent.actionName
              if (live.current.busy) return
              if (action === 'favorite') live.current.onToggleFavorite()
              else if (action === 'trash') live.current.onTrash()
              else if (action === 'move') live.current.onLongPress()
            }}
            disabled={busy}
            delayLongPress={350}
            onPressIn={() => {
              swiped.current = false
              longPressed.current = false
              if (!live.current.busy) live.current.onPressIn?.()
            }}
            onLongPress={() => {
              if (swiped.current || live.current.busy) return
              longPressed.current = true
              live.current.onLongPress()
            }}
            onPress={press}
            style={({ pressed }) => [s.noteRow, pressed && s.rowPressed]}
          >
            {children}
          </Pressable>
        </View>
      </GestureDetector>
      {pane === 'favorite' ? (
        <Reanimated.View
          renderToHardwareTextureAndroid
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[s.swipeAction, s.swipeFavoritePane, favoritePaneStyle]}
        >
          <Reanimated.View style={[s.swipeActionContent, favoriteContentStyle]}>
            <View style={s.swipeConfirm}>
              <Icon
                name={favorite ? 'star' : 'star-outline'}
                size={armed === 'favorite' ? 23 : 21}
                color={colors.accent}
              />
            </View>
            <Text style={[s.swipeActionLabel, { color: colors.onAccent }]}>
              {armed === 'favorite' ? 'RELEASE' : favorite ? 'UNFAVORITE' : 'FAVORITE'}
            </Text>
          </Reanimated.View>
        </Reanimated.View>
      ) : null}
      {pane === 'trash' ? (
        <Reanimated.View
          renderToHardwareTextureAndroid
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[s.swipeAction, s.swipeTrashPane, trashPaneStyle]}
        >
          <Reanimated.View style={[s.swipeActionContent, trashContentStyle]}>
            <View style={s.swipeConfirm}>
              <Icon
                name={armed === 'trash' ? 'delete-empty-outline' : 'trash-can-outline'}
                size={armed === 'trash' ? 21 : 20}
                color={isDark ? '#ffffff' : '#000000'}
              />
            </View>
            <Text style={[s.swipeActionLabel, !isDark && { color: '#ffffff' }]}>
              {armed === 'trash' ? 'RELEASE' : 'TRASH'}
            </Text>
          </Reanimated.View>
        </Reanimated.View>
      ) : null}
    </View>
  )
}

const NoteRow = memo(
  function NoteRow({
    result,
    busy,
    favorite,
    onPressIn,
    onPress,
    onLongPress,
    onToggleFavorite,
    onTrash,
  }: {
    result: SearchResult
    busy: boolean
    favorite: boolean
    onPressIn: (result: SearchResult) => void
    onPress: (result: SearchResult) => void
    onLongPress: (result: SearchResult) => void
    onToggleFavorite: (result: SearchResult) => void
    onTrash: (result: SearchResult) => void
  }) {
    const s = useStyles()
    const { colors } = useTheme()
    const { note, snippet, line } = result
    return (
      <SwipeRow
        busy={busy}
        favorite={favorite}
        noun="note"
        label={`${note.title}, ${note.path}`}
        onPressIn={() => onPressIn(result)}
        onPress={() => onPress(result)}
        onLongPress={() => onLongPress(result)}
        onToggleFavorite={() => onToggleFavorite(result)}
        onTrash={() => onTrash(result)}
      >
        <View style={s.noteGlyph}>
          <Icon name="file-document-outline" size={22} />
        </View>
        <View style={s.noteInfo}>
          <Text numberOfLines={1} style={s.noteTitle}>
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
        {favorite ? <Icon name="star" size={15} color={colors.accent} /> : null}
        <Icon name="chevron-right" size={16} color={colors.muted} />
      </SwipeRow>
    )
  },
  (previous, next) =>
    previous.result.note === next.result.note &&
    previous.result.snippet === next.result.snippet &&
    previous.result.line === next.result.line &&
    previous.busy === next.busy &&
    previous.favorite === next.favorite &&
    previous.onPressIn === next.onPressIn &&
    previous.onPress === next.onPress &&
    previous.onLongPress === next.onLongPress &&
    previous.onToggleFavorite === next.onToggleFavorite &&
    previous.onTrash === next.onTrash
)

const FolderRow = memo(
  function FolderRow({
    entry,
    busy,
    favorite,
    onPress,
    onLongPress,
    onToggleFavorite,
    onTrash,
  }: {
    entry: FolderEntry
    busy: boolean
    favorite: boolean
    onPress: (path: string) => void
    onLongPress: (entry: FolderEntry) => void
    onToggleFavorite: (entry: FolderEntry) => void
    onTrash: (entry: FolderEntry) => void
  }) {
    const s = useStyles()
    const { colors } = useTheme()
    return (
      <SwipeRow
        busy={busy}
        favorite={favorite}
        noun="folder"
        label={`Folder ${entry.name}`}
        onPress={() => onPress(entry.path)}
        onLongPress={() => onLongPress(entry)}
        onToggleFavorite={() => onToggleFavorite(entry)}
        onTrash={() => onTrash(entry)}
      >
        <View style={s.folderGlyph}>
          <Icon name="folder-outline" size={22} color={colors.accent} />
        </View>
        <View style={s.noteInfo}>
          <Text numberOfLines={1} style={s.noteTitle}>
            {entry.name}
          </Text>
          <Text numberOfLines={1} style={s.notePath}>
            Folder
          </Text>
        </View>
        {favorite ? <Icon name="star" size={15} color={colors.accent} /> : null}
        <Icon name="chevron-right" size={16} color={colors.muted} />
      </SwipeRow>
    )
  },
  (previous, next) =>
    previous.entry.path === next.entry.path &&
    previous.entry.name === next.entry.name &&
    previous.busy === next.busy &&
    previous.favorite === next.favorite &&
    previous.onPress === next.onPress &&
    previous.onLongPress === next.onLongPress &&
    previous.onToggleFavorite === next.onToggleFavorite &&
    previous.onTrash === next.onTrash
)

function ParentFolderRow({
  label,
  parentName,
  onPress,
}: {
  label: string
  parentName: string
  onPress: () => void
}) {
  const s = useStyles()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Go up from ${label}`}
      onPress={onPress}
      style={({ pressed }) => [s.parentRow, pressed && s.rowPressed]}
    >
      <View style={s.parentGlyph}>
        <Icon name="arrow-up" size={20} />
      </View>
      <View style={s.noteInfo}>
        <Text numberOfLines={1} style={s.parentTitle}>
          Up one folder
        </Text>
        <Text numberOfLines={1} style={s.notePath}>
          {parentName}
        </Text>
      </View>
    </Pressable>
  )
}

function LibraryNotice({ notice, onDone }: { notice: LibraryNotice; onDone: () => void }) {
  const s = useStyles()
  const { colors } = useTheme()
  const opacity = useRef(new Animated.Value(0)).current
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    let cancelled = false
    Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start()
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished && !cancelled) done.current()
        }
      )
    }, 3200)
    return () => {
      cancelled = true
      clearTimeout(timer)
      opacity.stopAnimation()
    }
  }, [opacity])
  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      pointerEvents="none"
      style={[
        s.notice,
        {
          opacity,
          transform: [
            {
              translateY: opacity.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }),
            },
          ],
        },
      ]}
    >
      <View style={s.noticeIcon}>
        <Icon name={notice.icon} size={18} color={colors.accent} />
      </View>
      <View style={s.flex}>
        <Text style={s.noticeTitle}>{notice.title}</Text>
        {notice.body ? (
          <Text numberOfLines={1} style={s.noticeBody}>
            {notice.body}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  )
}

function TrashNotice({ title, onDone }: { title: string; onDone: () => void }) {
  const s = useStyles()
  const { isDark } = useTheme()
  const opacity = useRef(new Animated.Value(0)).current
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    let cancelled = false
    Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start()
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished && !cancelled) done.current()
        }
      )
    }, 3200)
    return () => {
      cancelled = true
      clearTimeout(timer)
      opacity.stopAnimation()
    }
  }, [opacity])
  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      style={[
        s.trashNotice,
        {
          opacity,
          transform: [
            {
              translateY: opacity.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }),
            },
          ],
        },
      ]}
    >
      <View style={s.trashNoticeIcon}>
        <Icon name="trash-can-outline" size={17} color={isDark ? '#ffffff' : '#000000'} />
      </View>
      <View style={s.flex}>
        <Text style={s.trashNoticeTitle}>Moved to trash</Text>
        <Text numberOfLines={1} style={s.trashNoticeBody}>
          {title}
        </Text>
      </View>
    </Animated.View>
  )
}

function FolderSheet({
  folders,
  vault,
  initial,
  exclude,
  excludeTree,
  defaultParent,
  title,
  confirmLabel,
  busyLabel,
  onConfirm,
  onClose,
  onFolderCreated,
}: {
  folders: string[]
  vault: Vault
  initial: string | null
  exclude?: string
  excludeTree?: string
  defaultParent?: string
  title: string
  confirmLabel: string
  busyLabel?: string
  onConfirm: (destination: string) => Promise<void>
  onClose: () => void
  onFolderCreated: (folder: NoteFolder) => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const { bottom } = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const vaultName = vault.name
  const [destination, setDestination] = useState<string | null>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'browse' | 'new-folder' | 'new-parent'>('browse')
  const [folderParent, setFolderParent] = useState(defaultParent ?? initial ?? '')
  const [newFolderName, setNewFolderName] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const alive = useRef(true)
  const dragY = useRef(new Animated.Value(height)).current
  const dragStart = useRef(0)
  const dismiss = useRef(onClose)
  dismiss.current = onClose
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const destinations = useMemo(
    () =>
      folders
        .filter(
          (path) =>
            (exclude === undefined || path !== exclude) &&
            (excludeTree === undefined ||
              (path !== excludeTree && !path.startsWith(`${excludeTree}/`)))
        )
        .map((path) => ({
          path,
          name: path ? folderName(path) : vaultName,
          depth: path ? path.split('/').length - 1 : 0,
        })),
    [folders, exclude, excludeTree, vaultName]
  )
  const allFolders = useMemo(
    () =>
      folders.map((path) => ({
        path,
        name: path ? folderName(path) : vaultName,
        depth: path ? path.split('/').length - 1 : 0,
      })),
    [folders, vaultName]
  )
  const close = () => {
    if (busy || folderBusy) return
    Keyboard.dismiss()
    onClose()
  }
  const goBack = () => {
    if (folderBusy) return
    if (mode === 'new-parent') {
      setMode('new-folder')
      return
    }
    if (mode === 'new-folder') {
      setMode('browse')
      setFolderError(null)
      return
    }
    close()
  }
  const openNewFolder = () => {
    setFolderParent(destination ?? defaultParent ?? '')
    setNewFolderName('')
    setFolderError(null)
    setMode('new-folder')
  }
  const back = useRef(() => true)
  back.current = () => {
    if (busy || folderBusy) return true
    if (mode === 'browse') close()
    else goBack()
    return true
  }
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => back.current())
    return () => subscription.remove()
  }, [])
  const settleDrag = useCallback(
    (dismissSheet: boolean) => {
      if (dismissSheet) {
        Animated.timing(dragY, {
          toValue: height,
          duration: 180,
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished) dismiss.current()
        })
      } else {
        Animated.spring(dragY, {
          toValue: 0,
          speed: 24,
          bounciness: 0,
          useNativeDriver: true,
        }).start()
      }
    },
    [dragY, height]
  )
  const drag = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !busy && !folderBusy,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          !busy &&
          !folderBusy &&
          gesture.dy > 6 &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.2,
        onPanResponderGrant: () => {
          dragY.stopAnimation((value) => {
            dragStart.current = value
          })
        },
        onPanResponderMove: (_event, gesture) => {
          dragY.setValue(Math.max(0, dragStart.current + gesture.dy))
        },
        onPanResponderRelease: (_event, gesture) => {
          const position = dragStart.current + gesture.dy
          settleDrag(position > 90 || gesture.vy > 0.8)
        },
        onPanResponderTerminate: () => settleDrag(false),
        onPanResponderTerminationRequest: () => true,
      }),
    [busy, dragY, folderBusy, settleDrag]
  )
  const appeared = useRef(false)
  useEffect(() => {
    if (appeared.current) return
    appeared.current = true
    Animated.spring(dragY, {
      toValue: 0,
      speed: 24,
      bounciness: 0,
      useNativeDriver: true,
    }).start()
  }, [dragY])
  async function createNewFolder() {
    const value = newFolderName.trim()
    if (!value || folderBusy || busy) return
    setFolderBusy(true)
    setFolderError(null)
    try {
      const created = await createFolder(vault, value, folderParent)
      if (!alive.current) return
      onFolderCreated(created)
      setDestination(created.path)
      setMode('browse')
      setNewFolderName('')
      setFolderBusy(false)
    } catch (cause) {
      if (alive.current) {
        setFolderError(errorText(cause))
        setFolderBusy(false)
      }
    }
  }
  async function confirm() {
    if (destination === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(destination)
    } catch (cause) {
      if (alive.current) {
        setError(errorText(cause))
        setBusy(false)
      }
    }
  }
  return (
    <View
      style={[StyleSheet.absoluteFill, s.sheetOverlay, { zIndex: 12, elevation: 12 }]}
      accessibilityViewIsModal
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          s.sheetBackdrop,
          {
            opacity: dragY.interpolate({
              inputRange: [0, height * 0.5],
              outputRange: [1, 0],
              extrapolate: 'clamp',
            }),
          },
        ]}
      />
      <Pressable
        accessibilityLabel={`Dismiss ${title.toLowerCase()}`}
        onPress={close}
        style={StyleSheet.absoluteFill}
      />
      <KeyboardAvoidingView behavior="padding" style={s.sheetKeyboard} pointerEvents="box-none">
        <Animated.View
          style={[
            s.sheetCard,
            { paddingBottom: Math.max(bottom, 16) },
            { transform: [{ translateY: dragY }] },
          ]}
        >
          <View {...drag.panHandlers} style={s.sheetGrabber}>
            <View style={s.sheetHandle} />
          </View>
          <View style={s.sheetHeader}>
            {mode !== 'browse' ? (
              <IconButton
                name="arrow-left"
                label="Back"
                onPress={goBack}
                disabled={busy || folderBusy}
              />
            ) : null}
            <View style={s.flex}>
              <Text accessibilityRole="header" style={s.sheetTitle}>
                {mode === 'browse' ? title : mode === 'new-folder' ? 'New folder' : 'Choose parent'}
              </Text>
            </View>
            <IconButton
              name="close"
              label={`Close ${title.toLowerCase()}`}
              onPress={close}
              disabled={busy || folderBusy}
            />
          </View>
          {mode === 'browse' ? (
            <>
              <Text style={s.sheetLabel}>DESTINATION</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Create a new folder in ${(destination ?? folderParent) || vaultName}`}
                disabled={busy}
                onPress={openNewFolder}
                style={({ pressed }) => [
                  s.sheetRow,
                  s.sheetNewRow,
                  pressed && s.rowPressed,
                  busy && s.disabled,
                ]}
              >
                <View style={s.sheetNewIcon}>
                  <Icon name="plus" size={18} color={colors.accent} />
                </View>
                <View style={s.sheetRowText}>
                  <Text numberOfLines={1} style={s.sheetRowTitle}>
                    New folder
                  </Text>
                  <Text numberOfLines={1} style={s.sheetRowPath}>
                    In {(destination ?? folderParent) || vaultName}
                  </Text>
                </View>
                <Icon name="chevron-right" size={16} color={colors.muted} />
              </Pressable>
              <FlatList
                data={destinations}
                keyExtractor={(item) => item.path || 'root'}
                style={s.sheetList}
                contentContainerStyle={s.sheetListContent}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => {
                  const selected = destination === item.path
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityLabel={`Choose ${item.path || vaultName}`}
                      accessibilityState={{ selected }}
                      disabled={busy}
                      onPress={() => {
                        setDestination(item.path)
                        setError(null)
                      }}
                      style={({ pressed }) => [
                        s.sheetRow,
                        { paddingLeft: 20 + item.depth * 16 },
                        selected && s.sheetRowSelected,
                        pressed && s.rowPressed,
                      ]}
                    >
                      <Icon
                        name={item.path ? 'folder-outline' : 'home-outline'}
                        size={20}
                        color={selected ? colors.accent : colors.muted}
                      />
                      <View style={s.sheetRowText}>
                        <Text numberOfLines={1} style={s.sheetRowTitle}>
                          {item.name}
                        </Text>
                        <Text numberOfLines={1} style={s.sheetRowPath}>
                          {item.path || 'Vault root'}
                        </Text>
                      </View>
                      <Icon
                        name={selected ? 'check-circle' : 'circle-outline'}
                        size={21}
                        color={selected ? colors.accent : colors.muted}
                      />
                    </Pressable>
                  )
                }}
                ListEmptyComponent={
                  <View style={s.sheetEmpty}>
                    <Text style={s.sheetEmptyTitle}>No folders to choose yet.</Text>
                    <Text style={s.sheetEmptyBody}>
                      Create a new folder above, then choose it as the destination.
                    </Text>
                  </View>
                }
              />
              {error ? (
                <View style={s.sheetError}>
                  <ErrorBanner message={error} onDismiss={() => setError(null)} />
                </View>
              ) : null}
              <View style={s.sheetFooter}>
                <Action
                  label={busy && busyLabel ? busyLabel : confirmLabel}
                  busy={busy}
                  disabled={destination === null}
                  onPress={() => void confirm()}
                  icon="arrow-right"
                />
              </View>
            </>
          ) : mode === 'new-folder' ? (
            <>
              <Text style={s.sheetLabel}>PARENT FOLDER</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Choose a parent folder. Currently ${folderParent || vaultName}`}
                disabled={folderBusy}
                onPress={() => setMode('new-parent')}
                style={({ pressed }) => [
                  s.sheetRow,
                  pressed && s.rowPressed,
                  folderBusy && s.disabled,
                ]}
              >
                <Icon
                  name={folderParent ? 'folder-outline' : 'home-outline'}
                  size={20}
                  color={colors.accent}
                />
                <View style={s.sheetRowText}>
                  <Text numberOfLines={1} style={s.sheetRowTitle}>
                    {folderParent ? folderName(folderParent) : vaultName}
                  </Text>
                  <Text numberOfLines={1} style={s.sheetRowPath}>
                    {folderParent || 'Vault root'}
                  </Text>
                </View>
                <Icon name="chevron-right" size={16} color={colors.muted} />
              </Pressable>
              <Text style={s.sheetLabel}>NAME</Text>
              <View style={s.sheetFolderForm}>
                <TextInput
                  accessibilityLabel="New folder name"
                  autoFocus
                  value={newFolderName}
                  onChangeText={(value) => {
                    setNewFolderName(value)
                    setFolderError(null)
                  }}
                  editable={!folderBusy}
                  maxLength={120}
                  placeholder="Folder name"
                  placeholderTextColor={colors.muted}
                  returnKeyType="done"
                  onSubmitEditing={() => void createNewFolder()}
                  autoCorrect={false}
                  style={s.sheetFolderInput}
                />
                {folderError ? (
                  <Text accessibilityLiveRegion="polite" style={s.sheetFolderError}>
                    {folderError}
                  </Text>
                ) : null}
                <View style={s.sheetFolderActions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={folderBusy}
                    onPress={goBack}
                    style={({ pressed }) => [
                      s.dialogCancel,
                      pressed && s.pressed,
                      folderBusy && s.disabled,
                    ]}
                  >
                    <Text style={s.dialogCancelText}>Cancel</Text>
                  </Pressable>
                  <Action
                    label={folderBusy ? 'Creating…' : 'Create'}
                    busy={folderBusy}
                    disabled={!newFolderName.trim()}
                    onPress={() => void createNewFolder()}
                  />
                </View>
              </View>
            </>
          ) : (
            <>
              <Text style={s.sheetLabel}>CREATE FOLDER IN</Text>
              <Text style={s.sheetParentHint}>
                Choose any folder. The new folder is created inside it.
              </Text>
              <FlatList
                data={allFolders}
                keyExtractor={(item) => item.path || 'root'}
                style={s.sheetList}
                contentContainerStyle={s.sheetListContent}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => {
                  const selected = folderParent === item.path
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityLabel={`Create folder in ${item.path || vaultName}`}
                      accessibilityState={{ selected }}
                      disabled={folderBusy}
                      onPress={() => {
                        setFolderParent(item.path)
                        setFolderError(null)
                        setMode('new-folder')
                      }}
                      style={({ pressed }) => [
                        s.sheetRow,
                        { paddingLeft: 20 + item.depth * 16 },
                        selected && s.sheetRowSelected,
                        pressed && s.rowPressed,
                      ]}
                    >
                      <Icon
                        name={item.path ? 'folder-outline' : 'home-outline'}
                        size={20}
                        color={selected ? colors.accent : colors.muted}
                      />
                      <View style={s.sheetRowText}>
                        <Text numberOfLines={1} style={s.sheetRowTitle}>
                          {item.name}
                        </Text>
                        <Text numberOfLines={1} style={s.sheetRowPath}>
                          {item.path || 'Vault root'}
                        </Text>
                      </View>
                      <Icon
                        name={selected ? 'check-circle' : 'circle-outline'}
                        size={21}
                        color={selected ? colors.accent : colors.muted}
                      />
                    </Pressable>
                  )
                }}
              />
            </>
          )}
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  )
}

function AboutSheet({ onClose }: { onClose: () => void }) {
  const s = useStyles()
  const { colors } = useTheme()
  const { bottom } = useSafeAreaInsets()
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close.current()
      return true
    })
    return () => subscription.remove()
  }, [])
  const open = (url: string) => {
    void Linking.openURL(url).catch(() => {})
  }
  const shortCommit = appCommit ? appCommit.slice(0, 7) : null
  return (
    <View
      style={[StyleSheet.absoluteFill, s.sheetOverlay, { zIndex: 12, elevation: 12 }]}
      accessibilityViewIsModal
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, s.sheetBackdrop]} />
      <Pressable
        accessibilityLabel="Dismiss about Typo"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <View style={[s.sheetCard, { paddingBottom: Math.max(bottom, 16) }]}>
        <View style={s.sheetGrabber}>
          <View style={s.sheetHandle} />
        </View>
        <View style={s.sheetHeader}>
          <View style={s.flex}>
            <Text accessibilityRole="header" style={s.sheetTitle}>
              About Typo
            </Text>
          </View>
          <IconButton name="close" label="Close about Typo" onPress={onClose} />
        </View>
        <View style={s.sheetRow}>
          <Icon name="information-outline" size={20} color={colors.muted} />
          <View style={s.sheetRowText}>
            <Text style={s.sheetRowTitle}>Version</Text>
          </View>
          <Text style={s.aboutValue}>{appVersion}</Text>
        </View>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={
            shortCommit ? `Commit ${shortCommit}. Opens in your browser` : 'Development build'
          }
          disabled={!shortCommit}
          onPress={() => {
            if (appCommit) open(commitUrl(appCommit))
          }}
          style={({ pressed }) => [s.sheetRow, pressed && s.rowPressed]}
        >
          <Icon name="source-commit" size={20} color={colors.muted} />
          <View style={s.sheetRowText}>
            <Text style={s.sheetRowTitle}>Commit</Text>
            <Text numberOfLines={1} style={s.sheetRowPath}>
              {shortCommit ?? 'Development build'}
            </Text>
          </View>
          {shortCommit ? <Icon name="open-in-new" size={16} color={colors.muted} /> : null}
        </Pressable>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Report an issue. Opens in your browser"
          onPress={() => open(issuesUrl)}
          style={({ pressed }) => [s.sheetRow, pressed && s.rowPressed]}
        >
          <Icon name="bug-outline" size={20} color={colors.muted} />
          <View style={s.sheetRowText}>
            <Text style={s.sheetRowTitle}>Report an issue</Text>
            <Text numberOfLines={1} style={s.sheetRowPath}>
              {issuesUrl.replace('https://', '')}
            </Text>
          </View>
          <Icon name="open-in-new" size={16} color={colors.muted} />
        </Pressable>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Source code. Opens in your browser"
          onPress={() => open(repositoryUrl)}
          style={({ pressed }) => [s.sheetRow, pressed && s.rowPressed]}
        >
          <Icon name="code-tags" size={20} color={colors.muted} />
          <View style={s.sheetRowText}>
            <Text style={s.sheetRowTitle}>Source</Text>
            <Text numberOfLines={1} style={s.sheetRowPath}>
              {repositoryUrl.replace('https://', '')}
            </Text>
          </View>
          <Icon name="open-in-new" size={16} color={colors.muted} />
        </Pressable>
      </View>
    </View>
  )
}

function NoteDetail({
  workspace,
  active,
  onPrepared,
  session,
  note,
  opening = false,
  openError,
  initialLine,
  initialQuery,
  onClose,
  onSave,
  onSaveError,
}: {
  workspace: PdfWorkspace
  active: boolean
  onPrepared: (session: number) => void
  session: number
  note: Note
  opening?: boolean
  openError?: string
  initialLine?: number
  initialQuery: string
  onClose: () => void
  onSave: (note: Note) => void
  onSaveError: (message: string) => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const { top } = useSafeAreaInsets()
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
  const [sharing, setSharing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const shareEpoch = useRef(0)
  const alive = useRef(true)
  const editor = useRef<SourceEditorHandle>(null)
  const pendingSave = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writing = useRef<Promise<string | null> | null>(null)
  const closing = useRef(false)
  const editState = useRef({ documentId, source, savedNote, active, opening })
  editState.current = { documentId, source, savedNote, active, opening }
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
    setSharing(false)
    setError(null)
    setPdfError(null)
    editor.current?.blur()
    setEditing(false)
  }

  async function close() {
    if (closing.current) return
    closing.current = true
    shareEpoch.current++
    setSharing(false)
    editor.current?.blur()
    Keyboard.dismiss()
    const failure = await flushSave()
    closing.current = false
    // The note leaves the screen, so the library has to carry the failure.
    if (failure) onSaveError(failure)
    onClose()
  }
  function switchMode(next: 'source' | 'pdf') {
    if (next === mode) return
    editor.current?.blur()
    Keyboard.dismiss()
    if (next === 'pdf') setEditing(false)
    setMode(next)
  }
  // Callers share the write in flight, so two saves never race each other.
  function save(): Promise<string | null> {
    writing.current ??= write().finally(() => {
      writing.current = null
    })
    return writing.current
  }
  async function write(): Promise<string | null> {
    for (;;) {
      const current = editState.current
      if (current.source === current.savedNote.source) return null
      const source = current.source
      setError(null)
      try {
        const saved = await saveNote(current.savedNote, source)
        const updated = { ...current.savedNote, ...saved, pdfHash: undefined }
        // Stay ahead of React so the next write compares against the file we just wrote.
        editState.current.savedNote = updated
        if (alive.current) setSavedNote(updated)
        onSave(updated)
      } catch (cause) {
        const message = errorText(cause)
        if (alive.current) setError(message)
        return message
      }
    }
  }
  function scheduleSave() {
    if (pendingSave.current) clearTimeout(pendingSave.current)
    pendingSave.current = setTimeout(() => {
      pendingSave.current = null
      void save()
    }, AUTO_SAVE_DELAY)
  }
  function flushSave(nextSource?: string): Promise<string | null> {
    if (pendingSave.current) {
      clearTimeout(pendingSave.current)
      pendingSave.current = null
    }
    if (nextSource !== undefined) editState.current.source = nextSource
    return save()
  }
  async function share() {
    if (!active || opening || sharing) return
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

  // Show whatever PDF already exists instead of waiting for the next compile.
  const pdfUri = autoPdf.preview?.uri ?? null
  // Editing often leaves Typst briefly incomplete. Keep the last error hidden while the
  // editor has focus, so a half-typed construct does not flash a failure banner.
  const compileError = editing ? null : autoPdf.error
  // In PDF mode the viewer also mounts before the first compile, so it can show the spinner
  // and have its webview booted by the time the PDF is ready.
  const showPdf = !pdfError && (!!autoPdf.preview || (mode === 'pdf' && !autoPdf.error))

  return (
    <Screen onClose={close} visible={active}>
      <View style={s.screen}>
        {/* Android does not resize the window for the keyboard, so pad on both
            platforms. The offset is this screen's top safe-area padding. */}
        <KeyboardAvoidingView
          style={s.flex}
          enabled={active}
          behavior="padding"
          keyboardVerticalOffset={top}
        >
          <View style={s.detailToolbar}>
            <IconButton name="arrow-left" label="Back to notes" onPress={close} />
            <View style={s.toolbarTitle}>
              <Text numberOfLines={1} style={s.toolbarHeading}>
                {savedNote.title}
              </Text>
              <Text numberOfLines={1} style={s.notePath}>
                {savedNote.path}
              </Text>
            </View>
            <IconButton
              name="share-variant-outline"
              label={mode === 'source' ? 'Share Typst source' : 'Share PDF'}
              onPress={() => void share()}
              disabled={opening || sharing || (mode === 'pdf' && (!!autoPdf.error || !!pdfError))}
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
                name={findOpen ? 'close' : 'magnify'}
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
          {compileError && (
            <View style={s.errorInset}>
              <ErrorBanner
                title="PDF compilation failed"
                message={`${savedNote.path}\n\n${compileError}`}
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
                  <Icon name="magnify" size={18} color={colors.muted} />
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
              {isRootTemplate(savedNote.path) && (
                <TemplateHint
                  onInsert={(placeholder) => editor.current?.insert(placeholder)}
                  disabled={opening}
                />
              )}
              <SourceEditor
                ref={editor}
                documentId={documentId}
                value={source}
                onChangeText={(text) => {
                  setSource(text)
                  setSelection(undefined)
                  scheduleSave()
                }}
                selection={selection}
                editable={active && mode === 'source' && !opening}
                waitForKeyboardHide={!findOpen}
                onPainted={() => onPrepared(session)}
                onFocusChange={setEditing}
                onError={(message, fatal = true) => {
                  setError(message)
                  if (fatal) onPrepared(session)
                }}
                onSave={(text) => void flushSave(text)}
              />
            </View>
            <View
              style={[StyleSheet.absoluteFill, { opacity: mode === 'pdf' ? 1 : 0 }]}
              pointerEvents={mode === 'pdf' ? 'auto' : 'none'}
              accessibilityElementsHidden={mode !== 'pdf'}
              importantForAccessibility={mode === 'pdf' ? 'auto' : 'no-hide-descendants'}
            >
              {(compileError || pdfError) && (
                <View style={s.errorInset}>
                  {pdfError && <ErrorBanner title="PDF viewer failed" message={pdfError} />}
                  <Action
                    label="Retry PDF"
                    onPress={() => {
                      setPdfError(null)
                      autoPdf.retry()
                    }}
                  />
                </View>
              )}
              {showPdf ? (
                <Pdf
                  source={pdfUri ? { uri: pdfUri } : null}
                  style={s.pdf}
                  onError={(cause) => setPdfError(errorText(cause))}
                />
              ) : null}
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Screen>
  )
}

function TemplateHint({
  onInsert,
  disabled = false,
}: {
  onInsert: (placeholder: string) => void
  disabled?: boolean
}) {
  const s = useStyles()
  return (
    <View style={s.templateHint}>
      <Text style={s.templateHintText}>New notes start from template.typ.</Text>
      {[
        ['{{title}}', 'becomes the note title'],
        ['{{body}}', 'becomes the note body'],
      ].map(([placeholder, hint]) => (
        <View key={placeholder} style={s.placeholderRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Insert ${placeholder}`}
            disabled={disabled}
            onPress={() => onInsert(placeholder)}
            style={({ pressed }) => [
              s.placeholderChip,
              pressed && s.rowPressed,
              disabled && s.disabled,
            ]}
          >
            <Text style={s.placeholderText}>{placeholder}</Text>
          </Pressable>
          <Text style={s.placeholderHint}>{hint}</Text>
        </View>
      ))}
    </View>
  )
}

function NewNote({
  vault,
  folders,
  directory,
  initialTemplate,
  onClose,
  onCreated,
  onFolderCreated,
  onTemplateSaved,
}: {
  vault: Vault
  folders: string[]
  directory: string
  initialTemplate?: string
  onClose: () => void
  onCreated: (note: Note) => void
  onFolderCreated: (folder: NoteFolder) => void
  onTemplateSaved: (source: string) => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const { top } = useSafeAreaInsets()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const bodyRef = useRef<React.ComponentRef<typeof TextInput>>(null)
  const [destination, setDestination] = useState(directory)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState(false)
  const [template, setTemplate] = useState<string | null>(initialTemplate ?? null)
  const [templateLoading, setTemplateLoading] = useState(initialTemplate === undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    if (initialTemplate !== undefined) {
      setTemplate(initialTemplate)
      setTemplateLoading(false)
      return () => {
        alive.current = false
      }
    }
    setTemplate(null)
    setTemplateLoading(true)
    void readTemplate(vault)
      .then((source) => {
        if (alive.current) setTemplate(source)
      })
      .catch((cause: unknown) => {
        if (alive.current) setError(errorText(cause))
      })
      .finally(() => {
        if (alive.current) setTemplateLoading(false)
      })
    return () => {
      alive.current = false
    }
  }, [vault, initialTemplate])
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
    if (!title.trim() || saving || template === null) return
    setSaving(true)
    setError(null)
    try {
      const note = await createNote(vault, title.trim(), body, destination, template)
      if (alive.current) onCreated(note)
    } catch (cause) {
      if (alive.current) setError(errorText(cause))
    } finally {
      if (alive.current) setSaving(false)
    }
  }
  return (
    <>
      <Screen onClose={close}>
        <View
          style={s.screen}
          accessibilityElementsHidden={pickingFolder || editingTemplate}
          importantForAccessibility={
            pickingFolder || editingTemplate ? 'no-hide-descendants' : 'auto'
          }
        >
          {/* Android does not resize the window for the keyboard, so pad on both
              platforms. The offset is this screen's top safe-area padding. */}
          <KeyboardAvoidingView
            style={s.flex}
            importantForAccessibility={
              confirming || editingTemplate ? 'no-hide-descendants' : 'auto'
            }
            behavior="padding"
            keyboardVerticalOffset={top}
          >
            <View style={s.detailToolbar}>
              <IconButton name="close" label="Close new note" onPress={close} disabled={saving} />
              <Text style={[s.toolbarHeading, s.flex]}>New note</Text>
            </View>
            <ScrollView
              style={s.flex}
              contentContainerStyle={s.newForm}
              keyboardShouldPersistTaps="handled"
            >
              <View style={s.newIntro}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Create in ${destination || vault.name}. Choose folder`}
                  disabled={saving}
                  onPress={() => {
                    Keyboard.dismiss()
                    setPickingFolder(true)
                  }}
                  style={({ pressed }) => [
                    s.newLocation,
                    pressed && s.rowPressed,
                    saving && s.disabled,
                  ]}
                >
                  <Icon name="folder-outline" size={16} color={colors.muted} />
                  <Text numberOfLines={1} style={s.newLocationText}>
                    {destination || vault.name}
                  </Text>
                  <Icon name="chevron-down" size={14} color={colors.muted} />
                </Pressable>
                <Text style={s.caption}>Template</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Edit note template"
                  disabled={saving || templateLoading || template === null}
                  onPress={() => {
                    Keyboard.dismiss()
                    setEditingTemplate(true)
                  }}
                  style={({ pressed }) => [
                    s.templateRow,
                    pressed && s.rowPressed,
                    (saving || templateLoading || template === null) && s.disabled,
                  ]}
                >
                  <View style={s.flex}>
                    <Text style={s.templateName}>Vault template</Text>
                    <Text style={s.templatePath}>template.typ</Text>
                  </View>
                  <View style={s.templateAction}>
                    <Icon name="pencil-outline" size={16} color={colors.accent} />
                    <Text style={s.templateActionText}>Edit</Text>
                  </View>
                </Pressable>
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
                submitBehavior="submit"
                onSubmitEditing={() => bodyRef.current?.focus()}
              />
              <TextInput
                ref={bodyRef}
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
            </ScrollView>
            <View style={s.createFooter}>
              <Action
                label="Create note"
                busy={saving}
                disabled={!title.trim() || templateLoading || template === null}
                icon="plus"
                onPress={() => void create()}
              />
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
      {pickingFolder && (
        <FolderSheet
          folders={folders}
          vault={vault}
          initial={destination}
          title="Create in"
          confirmLabel="Use folder"
          onConfirm={async (path) => {
            setDestination(path)
            setPickingFolder(false)
          }}
          onFolderCreated={onFolderCreated}
          onClose={() => setPickingFolder(false)}
        />
      )}
      {editingTemplate && template !== null && (
        <TemplateEditor
          vault={vault}
          source={template}
          onClose={() => setEditingTemplate(false)}
          onSaved={(source) => {
            setTemplate(source)
            setEditingTemplate(false)
            onTemplateSaved(source)
          }}
        />
      )}
    </>
  )
}

function TemplateEditor({
  vault,
  source,
  onClose,
  onSaved,
}: {
  vault: Vault
  source: string
  onClose: () => void
  onSaved: (source: string) => void
}) {
  const s = useStyles()
  const { colors, palette } = useTheme()
  const { top } = useSafeAreaInsets()
  const [current, setCurrent] = useState(source)
  const [selection, setSelection] = useState({ start: source.length, end: source.length })
  const saved = source
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const editor = useRef<React.ComponentRef<typeof TextInput>>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const dirty = current !== saved
  const spans = useMemo(
    () =>
      templateSpans(current, {
        placeholder: colors.accent,
        comment: palette.overlay2,
        string: palette.green,
        keyword: palette.mauve,
        function: palette.blue,
        number: palette.peach,
        heading: palette.blue,
      }),
    [current, colors.accent, palette]
  )
  const close = () => {
    if (saving) return
    if (confirming) {
      setConfirming(false)
      return
    }
    Keyboard.dismiss()
    if (dirty) setConfirming(true)
    else onClose()
  }
  async function save(value = current) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await saveTemplate(vault, value, saved)
      if (alive.current) onSaved(value)
    } catch (cause) {
      if (alive.current) setError(errorText(cause))
    } finally {
      if (alive.current) setSaving(false)
    }
  }
  function insert(text: string) {
    const start = Math.min(selection.start, current.length)
    const end = Math.min(Math.max(selection.end, start), current.length)
    const caret = start + text.length
    setCurrent(current.slice(0, start) + text + current.slice(end))
    setSelection({ start: caret, end: caret })
    editor.current?.focus()
  }
  return (
    <Screen onClose={close}>
      <View style={s.screen}>
        <KeyboardAvoidingView
          style={s.flex}
          importantForAccessibility={confirming ? 'no-hide-descendants' : 'auto'}
          behavior="padding"
          keyboardVerticalOffset={top}
        >
          <View style={s.detailToolbar}>
            <IconButton
              name="close"
              label="Close template editor"
              onPress={close}
              disabled={saving}
            />
            <Text style={[s.toolbarHeading, s.flex]}>Template</Text>
          </View>
          <TemplateHint onInsert={insert} disabled={saving} />
          {error && (
            <View style={s.errorInset}>
              <ErrorBanner message={error} onDismiss={() => setError(null)} />
            </View>
          )}
          <ScrollView
            style={s.flex}
            contentContainerStyle={s.templateScroll}
            keyboardShouldPersistTaps="handled"
          >
            <View style={s.templateCode}>
              <View style={s.templateCodeInner}>
                <TextInput
                  ref={editor}
                  accessibilityLabel="Template source"
                  value={current}
                  onChangeText={setCurrent}
                  selection={selection}
                  onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
                  editable={!saving}
                  multiline
                  scrollEnabled={false}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  textAlignVertical="top"
                  cursorColor={colors.accent}
                  selectionColor={palette.surface1}
                  selectionHandleColor={colors.accent}
                  style={s.templateInput}
                />
                <Text style={s.templateText} pointerEvents="none">
                  {spans.map((span) => (
                    <Text key={span.from} style={span.color ? { color: span.color } : undefined}>
                      {span.text}
                    </Text>
                  ))}
                </Text>
              </View>
            </View>
          </ScrollView>
          <View style={s.sourceFooter}>
            <Action label="Save template" busy={saving} icon="check" onPress={() => void save()} />
          </View>
        </KeyboardAvoidingView>
        <ConfirmDialog
          visible={confirming}
          title="Discard template changes?"
          message="Your template changes haven’t been saved."
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
                        name="check"
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
  const { colors, settings } = useTheme()
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
        {[preview.base, preview[settings.accent], preview.text].map((color) => (
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
    launchScreen: {
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
    errorTitle: {
      color: colors.ink,
      fontSize: 15,
      lineHeight: 22,
      fontFamily: 'DMSans_600SemiBold',
      marginBottom: 6,
    },
    errorDetails: { maxHeight: 180 },
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
    listMetaEnd: { justifyContent: 'flex-end' },
    list: { paddingHorizontal: 24, paddingBottom: 106 },
    emptyList: { flexGrow: 1 },
    swipeShell: {
      position: 'relative',
      borderBottomColor: colors.line,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    swipeClipped: { overflow: 'hidden' },
    swipeAction: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: SWIPE_ACTION_WIDTH,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2,
    },
    swipeTrashPane: {
      right: 0,
      backgroundColor: colors.coral,
      borderTopLeftRadius: 15,
      borderBottomLeftRadius: 15,
    },
    swipeFavoritePane: {
      left: 0,
      backgroundColor: colors.accent,
      borderTopRightRadius: 15,
      borderBottomRightRadius: 15,
    },
    swipeActionContent: { alignItems: 'center', justifyContent: 'center', gap: 6 },
    swipeConfirm: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.paper,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 3,
      shadowColor: colors.ink,
      shadowOpacity: 0.18,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
    },
    swipeActionLabel: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 10,
      letterSpacing: 1.4,
      color: colors.paper,
    },
    swipeForeground: { backgroundColor: colors.paper, zIndex: 1 },
    noteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 20,
    },
    rowPressed: { backgroundColor: colors.soft },
    trashNotice: {
      position: 'absolute',
      left: 24,
      right: 24,
      bottom: 92,
      minHeight: 58,
      borderRadius: 17,
      paddingVertical: 10,
      paddingHorizontal: 11,
      paddingRight: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      backgroundColor: colors.soft,
      borderColor: colors.line,
      borderWidth: StyleSheet.hairlineWidth,
      zIndex: 4,
      elevation: 6,
      shadowColor: '#000000',
      shadowOpacity: 0.22,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 5 },
    },
    trashNoticeIcon: {
      width: 34,
      height: 34,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.coral,
    },
    trashNoticeTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 14,
      color: colors.ink,
    },
    trashNoticeBody: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 17,
      color: colors.muted,
    },
    noteGlyph: {
      width: 39,
      height: 45,
      borderRadius: 11,
      backgroundColor: colors.soft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    folderGlyph: {
      width: 39,
      height: 45,
      borderRadius: 11,
      backgroundColor: colors.soft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    parentRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 14,
      borderBottomColor: colors.line,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    parentGlyph: {
      width: 39,
      height: 39,
      borderRadius: 12,
      backgroundColor: colors.soft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    parentTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 15,
      color: colors.ink,
      lineHeight: 20,
    },
    crumbs: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 12,
      minHeight: 40,
      borderRadius: 12,
      backgroundColor: colors.soft,
      paddingLeft: 2,
    },
    crumbRoot: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
    },
    crumbScroll: { alignItems: 'center', paddingRight: 10, gap: 2 },
    crumbGroup: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    crumbButton: {
      maxWidth: 180,
      minHeight: 40,
      justifyContent: 'center',
      paddingHorizontal: 6,
      borderRadius: 10,
    },
    crumbText: { fontFamily: 'DMSans_400Regular', fontSize: 13, color: colors.muted },
    crumbCurrent: { fontFamily: 'DMSans_600SemiBold', color: colors.ink },
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
    notice: {
      position: 'absolute',
      left: 24,
      right: 24,
      bottom: 92,
      minHeight: 58,
      borderRadius: 17,
      paddingVertical: 10,
      paddingHorizontal: 11,
      paddingRight: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      backgroundColor: colors.soft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      zIndex: 4,
      elevation: 6,
      shadowColor: '#000000',
      shadowOpacity: 0.22,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 5 },
    },
    noticeIcon: {
      width: 34,
      height: 34,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.paper,
    },
    noticeTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 14,
      color: colors.ink,
    },
    noticeBody: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 17,
      color: colors.muted,
    },
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
    templateRow: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingLeft: 14,
      paddingRight: 8,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.soft,
    },
    templateName: { fontFamily: 'DMSans_600SemiBold', fontSize: 14, color: colors.ink },
    templatePath: { fontFamily: 'DMSans_400Regular', fontSize: 12, color: colors.muted },
    templateAction: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 36,
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: colors.paper,
    },
    templateActionText: { fontFamily: 'DMSans_600SemiBold', fontSize: 13, color: colors.accent },
    templateHint: {
      marginHorizontal: 20,
      marginTop: 12,
      marginBottom: 4,
      padding: 14,
      gap: 10,
      borderRadius: 12,
      backgroundColor: colors.soft,
    },
    templateHintText: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      lineHeight: 19,
      color: colors.ink,
    },
    placeholderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    placeholderChip: {
      minWidth: 86,
      minHeight: 36,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.paper,
    },
    placeholderText: { fontFamily: 'DMSans_400Regular', fontSize: 13, color: colors.ink },
    placeholderHint: {
      flex: 1,
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.muted,
    },
    templateScroll: { flexGrow: 1 },
    templateCode: { flexGrow: 1, paddingHorizontal: 20, paddingVertical: 16 },
    templateCodeInner: { flexGrow: 1 },
    templateText: {
      fontFamily: 'monospace',
      fontSize: 14,
      lineHeight: 22,
      color: colors.ink,
      includeFontPadding: false,
    },
    templateInput: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      margin: 0,
      padding: 0,
      fontFamily: 'monospace',
      fontSize: 14,
      lineHeight: 22,
      color: colors.paper,
      backgroundColor: 'transparent',
      includeFontPadding: false,
      textAlignVertical: 'top',
    },
    newIntro: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 12, gap: 12 },
    newLocation: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 44,
      marginHorizontal: -8,
      paddingHorizontal: 8,
      borderRadius: 10,
    },
    newLocationText: {
      flexShrink: 1,
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.muted,
    },
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
    newForm: { flexGrow: 1 },
    newBody: {
      flex: 1,
      minHeight: 160,
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
    dialogActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: 8,
      marginTop: 8,
    },
    sheetOverlay: { flex: 1, justifyContent: 'flex-end' },
    sheetKeyboard: { flex: 1, justifyContent: 'flex-end' },
    sheetBackdrop: { backgroundColor: 'rgba(0, 0, 0, 0.45)' },
    sheetGrabber: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    sheetCard: {
      width: '100%',
      maxHeight: '86%',
      backgroundColor: colors.paper,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      paddingTop: 8,
    },
    sheetHandle: {
      width: 38,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.line,
      alignSelf: 'center',
      marginBottom: 6,
    },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 20,
      paddingBottom: 6,
    },
    sheetTitle: {
      fontFamily: 'Newsreader_400Regular',
      fontSize: 28,
      lineHeight: 32,
      letterSpacing: -0.4,
      color: colors.ink,
    },
    sheetLabel: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 11,
      letterSpacing: 1.2,
      color: colors.muted,
      paddingHorizontal: 20,
      marginTop: 10,
      marginBottom: 2,
    },
    sheetList: { flexShrink: 1 },
    sheetListContent: { paddingBottom: 4 },
    sheetRow: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 8,
      paddingRight: 14,
      marginHorizontal: 8,
      borderRadius: 14,
    },
    sheetRowSelected: { backgroundColor: colors.soft },
    sheetRowText: { flex: 1, gap: 1 },
    sheetRowTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 15,
      lineHeight: 20,
      color: colors.ink,
    },
    sheetRowPath: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 11,
      lineHeight: 16,
      color: colors.muted,
    },
    aboutValue: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.muted,
      paddingRight: 6,
    },
    sheetNewRow: { marginBottom: 2 },
    sheetNewIcon: {
      width: 20,
      height: 20,
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.soft,
    },
    sheetFolderForm: {
      marginHorizontal: 12,
      marginBottom: 6,
      padding: 12,
      borderRadius: 14,
      backgroundColor: colors.soft,
      gap: 8,
    },
    sheetParentHint: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 18,
      color: colors.muted,
      paddingHorizontal: 20,
      marginBottom: 4,
    },
    sheetFolderInput: {
      minHeight: 44,
      borderRadius: 10,
      paddingHorizontal: 12,
      backgroundColor: colors.paper,
      color: colors.ink,
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
    },
    sheetFolderError: {
      color: colors.coral,
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 18,
    },
    sheetFolderActions: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 8,
    },
    sheetEmpty: { alignItems: 'center', paddingHorizontal: 28, paddingVertical: 28, gap: 8 },
    sheetEmptyTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
      color: colors.ink,
    },
    sheetEmptyBody: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      lineHeight: 20,
      color: colors.muted,
      textAlign: 'center',
      maxWidth: 280,
    },
    sheetError: { paddingHorizontal: 20, paddingTop: 6 },
    sheetFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      paddingHorizontal: 20,
      paddingTop: 12,
      marginTop: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
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
