import { DMSans_400Regular, DMSans_600SemiBold, useFonts } from '@expo-google-fonts/dm-sans'
import { Newsreader_400Regular, Newsreader_400Regular_Italic } from '@expo-google-fonts/newsreader'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import * as FileSystem from 'expo-file-system/legacy'
import * as IntentLauncher from 'expo-intent-launcher'
import * as Sharing from 'expo-sharing'
import * as SplashScreen from 'expo-splash-screen'
import * as SystemUI from 'expo-system-ui'
import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
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
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
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
  ReduceMotion,
  runOnJS,
  SlideInRight,
  SlideOutRight,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { appCommit, appVersion, commitUrl, issuesUrl, repositoryUrl } from './src/about'
import { BackGate } from './src/back-gate'
import { type CompilerHandle, CompilerHost } from './src/CompilerHost'
import { contrastRatio, hexToHsl, hslToHex, parseHex, rgba } from './src/color'
import type { PdfWorkspace } from './src/compiler/workspace'
import {
  DEFAULT_TEMPLATE,
  foldersFromNotes,
  isRootTemplate,
  type NoteSort,
  reconcileNotes,
} from './src/core'
import { loadFavorites, storeFavorites } from './src/favorites'
import { Icon, type IconName } from './src/icons'
import { loadVaultIndex, storeVaultIndex } from './src/library-cache'
import {
  type FolderRowItem,
  type FolderRowsCache,
  type LibraryItem,
  sortedNoteRows,
} from './src/library-rows'
import { TypoMark } from './src/Mark'
import { NoteSearch } from './src/NoteSearch'
import Pdf from './src/PdfViewer'
import { SourceEditor, type SourceEditorHandle } from './src/SourceEditor'
import type { AppearanceMode, Flavor, ThemeColors } from './src/theme'
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
  restoreFolder,
  restoreNote,
  saveNote,
  saveTemplate,
  scanVaultLibrary,
  type TrashedNote,
  trashFolder,
  trashNote,
} from './src/vault'
import { webRuntime } from './src/web-runtime'

const fonts = {
  DMSans_400Regular,
  DMSans_600SemiBold,
  Newsreader_400Regular,
  Newsreader_400Regular_Italic,
  JetBrainsMono_400Regular: require('./assets/fonts/JetBrainsMono-Regular.ttf'),
}
// Keep the native launch screen up until the first themed frame is ready, then fade it out.
void SplashScreen.preventAutoHideAsync()
// Expo Go owns its own splash, so only real native builds can set the fade.
if (Constants.executionEnvironment !== ExecutionEnvironment.StoreClient) {
  SplashScreen.setOptions({ duration: 250, fade: true })
}
type NoteSession = SearchResult & {
  session: number
  opening?: boolean
  openError?: string
  created?: boolean
}
type FolderEntry = { path: string; name: string }
type LibraryNotice = {
  id: number
  icon: IconName
  title: string
  body?: string
}
type MovingItem = { kind: 'note'; result: SearchResult } | { kind: 'folder'; entry: FolderEntry }
type SearchRow =
  | { kind: 'header'; title: string; key: string }
  | { kind: 'result'; result: SearchResult }
type TrashUndo = {
  noticeId: number
  item: MovingItem
  favorites: string[]
  notes: Note[]
  folders: string[]
  result: Promise<TrashedNote | null>
}
type RowAction = 'favorite' | 'trash'
const warmNote: Note = { uri: '', path: '', title: '', source: '', modifiedAt: null }
const EMPTY_NOTES: Note[] = []
const EMPTY_FOLDERS: FolderRowItem[] = []
const MemoNoteDetail = memo(NoteDetail)
const MemoNoteSearch = memo(NoteSearch)
const MemoCompilerHost = memo(CompilerHost)
const noteSorts = [
  {
    key: 'name',
    label: 'Name',
    ascending: 'A → Z',
    descending: 'Z → A',
    ascValue: 'name-asc',
    descValue: 'name-desc',
    defaultValue: 'name-asc',
  },
  {
    key: 'modified',
    label: 'Modified',
    ascending: 'Oldest first',
    descending: 'Newest first',
    ascValue: 'modified-asc',
    descValue: 'modified-desc',
    defaultValue: 'modified-desc',
  },
] as const satisfies readonly {
  key: string
  label: string
  ascending: string
  descending: string
  ascValue: NoteSort
  descValue: NoteSort
  defaultValue: NoteSort
}[]
const SWIPE_ACTION_WIDTH = 120
const SWIPE_TRASH_DISTANCE = SWIPE_ACTION_WIDTH + 36
const SWIPE_FAVORITE_DISTANCE = SWIPE_ACTION_WIDTH + 36
const SWIPE_TOSS = 0.05
const SWIPE_SPRING = { damping: 26, mass: 0.7, overshootClamping: true, stiffness: 330 }
const SHEET_SPRING = { damping: 34, mass: 0.8, overshootClamping: true, stiffness: 340 }
const SCREEN_SPRING = { damping: 34, mass: 0.82, overshootClamping: true, stiffness: 320 }
const SCREEN_EDGE_WIDTH = 22
const folderIn = SlideInRight.duration(147).reduceMotion(ReduceMotion.System)
const folderOut = SlideOutRight.duration(147).reduceMotion(ReduceMotion.System)
const backEdgeStyle = {
  position: 'absolute' as const,
  top: 0,
  bottom: 0,
  left: 0,
  width: SCREEN_EDGE_WIDTH,
  zIndex: 10,
}
const AUTO_SAVE_DELAY = 600
const keyboardBehavior = 'padding'
const SEARCH_MODE: SearchMode = 'all'
// Mirrors `.cm-template .cm-scroller` in src/editor/web.ts.
const TEMPLATE_LINE_HEIGHT = 28
const TEMPLATE_CONTENT_TOP = 16

type MotionCallback = (finished?: boolean) => void

function spring(
  toValue: number,
  config: { damping: number; mass: number; overshootClamping: boolean; stiffness: number },
  callback?: MotionCallback
): number {
  'worklet'
  return withSpring(toValue, { ...config, reduceMotion: ReduceMotion.System }, callback)
}

function timing(toValue: number, config: { duration: number }, callback?: MotionCallback): number {
  'worklet'
  return withTiming(toValue, { ...config, reduceMotion: ReduceMotion.System }, callback)
}

function parentFolder(path: string): string {
  const end = path.lastIndexOf('/')
  return end === -1 ? '' : path.slice(0, end)
}

function folderName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.'

function IconButton({
  name,
  label,
  onPress,
  disabled = false,
}: {
  name: IconName
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
  icon?: IconName
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
      <Icon name="alert" color={colors.coral} />
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

function Screen({
  onClose,
  onRequestClose,
  onDismissStart,
  visible = true,
  instantIn = false,
  edge = 'right',
  swipeBack = false,
  dismissOnSwipe = true,
  insets = true,
  dismissRef,
  children,
}: {
  onClose: () => void
  onRequestClose?: () => void
  onDismissStart?: () => void
  visible?: boolean
  instantIn?: boolean
  edge?: 'right' | 'bottom'
  swipeBack?: boolean
  dismissOnSwipe?: boolean
  insets?: boolean
  dismissRef?: React.MutableRefObject<(after?: () => void) => void>
  children: React.ReactNode
}) {
  const { top, right, bottom, left } = useSafeAreaInsets()
  const { colors } = useTheme()
  const { width, height } = useWindowDimensions()
  const progress = useSharedValue(1)
  const dragStart = useSharedValue(1)
  const dragging = useSharedValue(false)
  const dismissing = useSharedValue(false)
  const [present, setPresent] = useState(visible)
  const [exiting, setExiting] = useState(false)
  const presentRef = useRef(visible)
  const shown = useRef(visible)
  const closing = useRef(false)
  const after = useRef<(() => void) | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  const request = useRef(onRequestClose)
  request.current = onRequestClose
  const startDismiss = useRef(onDismissStart)
  startDismiss.current = onDismissStart
  const beginDismiss = useCallback(() => {
    setExiting(true)
    startDismiss.current?.()
  }, [])
  const finish = useCallback(() => {
    if (!shown.current) return
    shown.current = false
    const done = after.current
    after.current = null
    if (done) done()
    else close.current()
  }, [])
  // A swipe that may not dismiss still has to take the touches away from the
  // content, so it asks the screen to handle it like Back.
  const requestClose = useCallback(() => {
    request.current?.()
  }, [])
  const dismiss = useCallback(
    (done?: () => void) => {
      if (closing.current || !visible) return
      closing.current = true
      dismissing.value = true
      after.current = done ?? null
      beginDismiss()
      Keyboard.dismiss()
      progress.value = timing(1, { duration: 200 }, (finished) => {
        'worklet'
        if (finished) runOnJS(finish)()
      })
    },
    [beginDismiss, dismissing, finish, progress, visible]
  )
  const commit = useCallback(() => {
    if (closing.current) return
    closing.current = true
    dismissing.value = true
    beginDismiss()
    Keyboard.dismiss()
    finish()
  }, [beginDismiss, dismissing, finish])
  // The note behind a dismissed sheet has to be in place before the sheet moves,
  // so becoming visible is applied in the layout pass.
  useLayoutEffect(() => {
    if (visible) {
      closing.current = false
      dismissing.value = false
      setExiting(false)
      shown.current = true
      presentRef.current = true
      setPresent(true)
      progress.value = instantIn ? 0 : timing(0, { duration: 220 })
      return
    }
    if (!presentRef.current) return
    presentRef.current = false
    progress.value = timing(1, { duration: 200 }, (finished) => {
      'worklet'
      if (finished) runOnJS(setPresent)(false)
    })
  }, [dismissing, instantIn, visible, progress])
  useLayoutEffect(() => {
    if (dismissRef) dismissRef.current = dismiss
  }, [dismiss, dismissRef])
  useLayoutEffect(() => {
    if (!visible) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (request.current) request.current()
      else dismiss()
      return true
    })
    return () => subscription.remove()
  }, [dismiss, visible])
  const interactive = visible && !exiting
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .enabled(swipeBack && interactive)
        .activeOffsetX(8)
        .failOffsetY([-18, 18])
        .onStart(() => {
          'worklet'
          dragging.value = true
          dragStart.value = progress.value
          if (!dismissOnSwipe) runOnJS(requestClose)()
        })
        .onUpdate((event) => {
          'worklet'
          if (!dismissOnSwipe || dismissing.value) return
          const next = dragStart.value + event.translationX / Math.max(width, 1)
          progress.value = Math.max(0, Math.min(1, next))
        })
        .onEnd((event) => {
          'worklet'
          if (!dismissOnSwipe) {
            dragging.value = false
            return
          }
          if (dismissing.value) {
            dragging.value = false
            return
          }
          const projected = progress.value + (event.velocityX / Math.max(width, 1)) * 0.12
          if (projected > 0.34 || event.velocityX > 650) {
            dismissing.value = true
            runOnJS(beginDismiss)()
            progress.value = timing(1, { duration: 180 }, (finished) => {
              'worklet'
              if (finished) runOnJS(commit)()
            })
          } else {
            progress.value = spring(0, SCREEN_SPRING)
          }
        })
        .onFinalize((_event, success) => {
          'worklet'
          if (
            dismissOnSwipe &&
            !success &&
            dragging.value &&
            !dismissing.value &&
            progress.value > 0 &&
            progress.value < 1
          ) {
            progress.value = spring(0, SCREEN_SPRING)
          }
          dragging.value = false
        }),
    [
      beginDismiss,
      commit,
      dismissing,
      dismissOnSwipe,
      dragStart,
      dragging,
      interactive,
      progress,
      requestClose,
      swipeBack,
      width,
    ]
  )
  const motion = useAnimatedStyle(() => ({
    transform:
      edge === 'bottom'
        ? [{ translateY: progress.value * height }]
        : [{ translateX: progress.value * width }],
  }))
  return (
    <Reanimated.View
      style={[StyleSheet.absoluteFill, { zIndex: present ? 2 : 0, elevation: present ? 4 : 0 }]}
      pointerEvents={interactive ? 'auto' : 'none'}
      accessibilityViewIsModal={interactive}
      accessibilityElementsHidden={!interactive}
      importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}
    >
      <Reanimated.View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: colors.paper,
            paddingTop: insets ? top : 0,
            paddingRight: insets ? right : 0,
            paddingBottom: insets ? bottom : 0,
            paddingLeft: insets ? left : 0,
          },
          motion,
        ]}
      >
        {children}
      </Reanimated.View>
      {swipeBack && interactive ? (
        <GestureDetector gesture={swipe}>
          <View style={backEdgeStyle} />
        </GestureDetector>
      ) : null}
    </Reanimated.View>
  )
}

function BottomSheet({
  title,
  leading,
  onClose,
  onRequestClose,
  busy = false,
  dismissRef,
  cardHeight,
  children,
}: {
  title: string
  leading?: React.ReactNode
  onClose: () => void
  onRequestClose?: () => boolean
  busy?: boolean
  dismissRef?: React.MutableRefObject<(after?: () => void) => void>
  cardHeight?: number
  children: React.ReactNode
}) {
  const s = useStyles()
  const { height } = useWindowDimensions()
  const { bottom, top } = useSafeAreaInsets()
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  const offset = useSharedValue(height)
  const start = useSharedValue(height)
  const dragging = useSharedValue(false)
  const dismissing = useSharedValue(false)
  const closing = useRef(false)
  const after = useRef<(() => void) | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  const request = useRef(onRequestClose)
  request.current = onRequestClose
  const finish = useCallback(() => {
    const done = after.current
    after.current = null
    if (done) done()
    else close.current()
  }, [])
  const commit = useCallback(() => {
    if (closing.current) return
    closing.current = true
    dismissing.value = true
    Keyboard.dismiss()
    finish()
  }, [dismissing, finish])
  const dismiss = useCallback(
    (done?: () => void) => {
      if (closing.current || busy) return
      closing.current = true
      dismissing.value = true
      after.current = done ?? null
      Keyboard.dismiss()
      offset.value = timing(height, { duration: 220 }, (finished) => {
        'worklet'
        if (finished) runOnJS(finish)()
      })
    },
    [busy, dismissing, finish, height, offset]
  )
  useLayoutEffect(() => {
    if (dismissRef) dismissRef.current = dismiss
  }, [dismiss, dismissRef])
  useEffect(() => {
    offset.value = timing(0, { duration: 200 })
  }, [offset])
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) =>
      setKeyboardHeight(event.endCoordinates.height)
    )
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  const keyboardMaxHeight =
    keyboardHeight > 0 ? Math.max(200, height - keyboardHeight - top) : undefined
  useLayoutEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) return true
      if (request.current?.()) return true
      dismiss()
      return true
    })
    return () => subscription.remove()
  }, [busy, dismiss])
  const drag = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!busy)
        .activeOffsetY([-8, 8])
        .failOffsetX([-24, 24])
        .onStart(() => {
          'worklet'
          if (dismissing.value) {
            dragging.value = false
            return
          }
          dragging.value = true
          start.value = offset.value
        })
        .onUpdate((event) => {
          'worklet'
          if (!dragging.value || dismissing.value) return
          const raw = start.value + event.translationY
          // Sheets only move down. Letting the handle drift up made the card
          // float and clip against the bottom of the screen.
          offset.value = Math.max(0, raw)
        })
        .onEnd((event) => {
          'worklet'
          if (!dragging.value || dismissing.value) return
          const projected = offset.value + event.velocityY * 0.08
          if (projected > Math.min(height * 0.22, 140) || event.velocityY > 850) {
            dismissing.value = true
            offset.value = timing(height, { duration: 200 }, (finished) => {
              'worklet'
              if (finished) runOnJS(commit)()
            })
          } else {
            offset.value = spring(0, SHEET_SPRING)
          }
        })
        .onFinalize((_event, success) => {
          'worklet'
          if (!success && dragging.value && !dismissing.value && offset.value !== 0) {
            offset.value = spring(0, SHEET_SPRING)
          }
          dragging.value = false
        }),
    [busy, commit, dismissing, dragging, height, offset, start]
  )
  const backdrop = useAnimatedStyle(() => ({
    opacity: interpolate(offset.value, [0, Math.max(height * 0.5, 1)], [1, 0], Extrapolation.CLAMP),
  }))
  const cardMotion = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }))
  const header = (
    <View>
      <View style={s.sheetGrabber}>
        <View style={s.sheetHandle} />
      </View>
      <View style={s.sheetHeader}>
        {leading}
        <View style={s.flex}>
          <Text accessibilityRole="header" style={s.sheetTitle}>
            {title}
          </Text>
        </View>
      </View>
    </View>
  )
  const card = (
    <Reanimated.View
      style={[
        s.sheetCard,
        { paddingBottom: Math.max(bottom, 24) },
        cardHeight !== undefined && { height: cardHeight },
        keyboardMaxHeight !== undefined && { maxHeight: keyboardMaxHeight },
        cardMotion,
      ]}
    >
      <GestureDetector gesture={drag}>{header}</GestureDetector>
      {children}
    </Reanimated.View>
  )
  return (
    <View
      style={[StyleSheet.absoluteFill, s.sheetOverlay, { zIndex: 12, elevation: 12 }]}
      accessibilityViewIsModal
    >
      <Reanimated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, s.sheetBackdrop, backdrop]}
      />
      <Pressable
        accessibilityLabel={`Dismiss ${title.toLowerCase()}`}
        disabled={busy}
        onPress={() => dismiss()}
        style={StyleSheet.absoluteFill}
      />
      <KeyboardAvoidingView
        behavior={keyboardBehavior}
        style={s.sheetKeyboard}
        pointerEvents="box-none"
      >
        {card}
      </KeyboardAvoidingView>
    </View>
  )
}

type DialogHostValue = {
  mount: (id: number, node: React.ReactNode) => void
  unmount: (id: number) => void
}

const DialogHostContext = createContext<DialogHostValue | null>(null)
let dialogSequence = 0

function DialogHost({ children }: { children: React.ReactNode }) {
  const [nodes, setNodes] = useState<{ id: number; node: React.ReactNode }[]>([])
  const value = useMemo<DialogHostValue>(
    () => ({
      mount: (id, node) =>
        setNodes((previous) => [...previous.filter((entry) => entry.id !== id), { id, node }]),
      unmount: (id) => setNodes((previous) => previous.filter((entry) => entry.id !== id)),
    }),
    []
  )
  return (
    <DialogHostContext.Provider value={value}>
      {children}
      {nodes.map(({ id, node }) => (
        <Fragment key={id}>{node}</Fragment>
      ))}
    </DialogHostContext.Provider>
  )
}

function Portal({ children }: { children: React.ReactNode }) {
  const host = useContext(DialogHostContext)
  const [id] = useState(() => ++dialogSequence)
  useLayoutEffect(() => {
    host?.mount(id, children)
    return () => host?.unmount(id)
  }, [children, host, id])
  return null
}

function Dialog({
  visible,
  title,
  message,
  onClose,
  local = false,
  children,
}: {
  visible: boolean
  title: string
  message?: string
  onClose(): void
  local?: boolean
  children: React.ReactNode
}) {
  const s = useStyles()
  useEffect(() => {
    if (!visible) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose()
      return true
    })
    return () => subscription.remove()
  }, [onClose, visible])
  if (!visible) return null
  // A native Modal re-composites the WebView behind it and makes the source
  // flash. Keep the overlay in the same subtree as the WebView as well, so the
  // dim actually paints over the editor instead of behind it.
  const content = (
    <View style={[StyleSheet.absoluteFill, s.dialogOverlay, s.dialogLayer]}>
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
  )
  return local ? content : <Portal>{content}</Portal>
}

function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Keep editing',
  local = false,
  onCancel,
  onConfirm,
}: {
  visible: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  local?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const s = useStyles()
  return (
    <Dialog visible={visible} title={title} message={message} onClose={onCancel} local={local}>
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
    <DialogHost>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      {launched ? <Library /> : <LaunchScreen />}
    </DialogHost>
  )
}

function LaunchScreen() {
  const s = useStyles()
  const opacity = useSharedValue(0)
  useEffect(() => {
    opacity.value = timing(1, { duration: 200 })
  }, [opacity])
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }))
  return (
    <View style={s.launchScreen}>
      <Reanimated.View style={fade}>
        <TypoMark size={120} />
      </Reanimated.View>
    </View>
  )
}

function Fade({ id, color, mid = 0.6 }: { id: string; color: string; mid?: number }) {
  return (
    <Svg width="100%" height="100%">
      <Defs>
        <LinearGradient id={id} x1="0" y1="1" x2="0" y2="0">
          <Stop offset="0" stopColor={color} stopOpacity={1} />
          <Stop offset={`${mid}`} stopColor={color} stopOpacity={1} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  )
}

function SwapIcon({
  from,
  to,
  active,
  size = 22,
  color,
  fromFill,
  toFill,
  activeScale = 1.1,
}: {
  from: IconName
  to: IconName
  active: boolean
  size?: number
  color?: string
  fromFill?: string
  toFill?: string
  activeScale?: number
}) {
  const s = useStyles()
  const progress = useSharedValue(active ? 1 : 0)
  useEffect(() => {
    progress.value = spring(active ? 1 : 0, {
      damping: 13,
      mass: 0.5,
      stiffness: 240,
      overshootClamping: false,
    })
  }, [active, progress])
  const outgoing = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [1, 0], Extrapolation.CLAMP),
    transform: [
      { scale: interpolate(progress.value, [0, 1], [1, 0.55], Extrapolation.CLAMP) },
      { rotate: `${interpolate(progress.value, [0, 1], [0, -20], Extrapolation.CLAMP)}deg` },
    ],
  }))
  const incoming = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0, 1], Extrapolation.CLAMP),
    transform: [
      { scale: interpolate(progress.value, [0, 1], [0.55, activeScale]) },
      { rotate: `${interpolate(progress.value, [0, 1], [20, 0], Extrapolation.CLAMP)}deg` },
    ],
  }))
  return (
    <View style={{ width: size, height: size }}>
      <Reanimated.View style={[s.swapIconLayer, outgoing]}>
        <Icon name={from} size={size} color={color} fill={fromFill} />
      </Reanimated.View>
      <Reanimated.View style={[s.swapIconLayer, incoming]}>
        <Icon name={to} size={size} color={color} fill={toFill} />
      </Reanimated.View>
    </View>
  )
}

function SwapLabel({
  idle,
  activeLabel,
  active,
  style,
}: {
  idle: string
  activeLabel: string
  active: boolean
  style?: React.ComponentProps<typeof Text>['style']
}) {
  const s = useStyles()
  const progress = useSharedValue(active ? 1 : 0)
  useEffect(() => {
    progress.value = spring(active ? 1 : 0, {
      damping: 15,
      mass: 0.45,
      stiffness: 260,
      overshootClamping: false,
    })
  }, [active, progress])
  const outgoing = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [1, 0], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(progress.value, [0, 1], [0, -3], Extrapolation.CLAMP) }],
  }))
  const incoming = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(progress.value, [0, 1], [3, 0], Extrapolation.CLAMP) }],
  }))
  return (
    <View style={s.swapLabel}>
      <Reanimated.Text numberOfLines={1} style={[style, s.swapLabelLayer, outgoing]}>
        {idle}
      </Reanimated.Text>
      <Reanimated.Text numberOfLines={1} style={[style, s.swapLabelLayer, incoming]}>
        {activeLabel}
      </Reanimated.Text>
    </View>
  )
}

function commonPrefixLength(value: string, needle: string): number {
  let index = 0
  while (index < value.length && index < needle.length && value[index] === needle[index]) index++
  return index
}

function HighlightedText({
  text,
  query,
  style,
  numberOfLines,
  fuzzy = false,
}: {
  text: string
  query: string
  style: React.ComponentProps<typeof Text>['style']
  numberOfLines?: number
  fuzzy?: boolean
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) {
    return (
      <Text numberOfLines={numberOfLines} style={style}>
        {text}
      </Text>
    )
  }
  const haystack = text.toLocaleLowerCase()
  let parts: { text: string; hit: boolean }[] = []
  let offset = 0
  for (;;) {
    const at = haystack.indexOf(needle, offset)
    if (at < 0) break
    if (at > offset) parts.push({ text: text.slice(offset, at), hit: false })
    parts.push({ text: text.slice(at, at + needle.length), hit: true })
    offset = at + needle.length
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), hit: false })
  if (fuzzy && !parts.some((part) => part.hit)) {
    // Fuzzy matches still need a visible anchor. Highlight the shared prefix,
    // so a search like "tesg" lights up "Tes" in "Test".
    const prefix = commonPrefixLength(haystack, needle)
    if (prefix > 0) {
      parts = [
        { text: text.slice(0, prefix), hit: true },
        ...(prefix < text.length ? [{ text: text.slice(prefix), hit: false }] : []),
      ]
    }
  }
  let cursor = 0
  return (
    <Text numberOfLines={numberOfLines} style={style}>
      {parts.map((part) => {
        const key = `${cursor}:${part.hit ? 'hit' : 'text'}`
        cursor += part.text.length
        return part.hit ? (
          <Text key={key} style={[s.highlight, { backgroundColor: rgba(colors.accent, 0.28) }]}>
            {part.text}
          </Text>
        ) : (
          <Text key={key}>{part.text}</Text>
        )
      })}
    </Text>
  )
}

function searchPreview(note: Note, query: string): string | undefined {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return undefined
  const lines = note.source.split('\n')
  const title = lines.findIndex(
    (line) => /^\s*=/u.test(line) && line.toLocaleLowerCase().includes(needle)
  )
  for (let index = 0; index < lines.length; index++) {
    if (index === title) continue
    const line = lines[index].trim()
    if (line.toLocaleLowerCase().includes(needle)) {
      const text = line.length > 180 ? `${line.slice(0, 180)}…` : line
      return `…${text}…`
    }
  }
  return undefined
}

const SearchResultRow = memo(
  function SearchResultRow({
    result,
    query,
    onPress,
    onLongPress,
  }: {
    result: SearchResult
    query: string
    onPress: (result: SearchResult) => void
    onLongPress: (result: SearchResult) => void
  }) {
    const s = useStyles()
    const parent = parentFolder(result.note.path)
    const needle = query.trim().toLocaleLowerCase()
    const preview = result.snippet ?? searchPreview(result.note, query)
    // A fuzzy content hit may have no literal query to highlight. Do not show
    // an unhighlighted body excerpt in that case.
    const snippet =
      preview && needle && preview.toLocaleLowerCase().includes(needle) ? preview : undefined
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${result.note.title}, ${result.note.path}`}
        onPress={() => onPress(result)}
        onLongPress={() => onLongPress(result)}
        delayLongPress={350}
        style={({ pressed }) => [s.searchRow, pressed && s.rowPressed]}
      >
        <View style={s.searchTitleRow}>
          <HighlightedText
            text={result.note.title}
            query={query}
            numberOfLines={1}
            fuzzy
            style={s.searchTitle}
          />
          <Text numberOfLines={1} style={s.searchPath}>
            {parent ? `${parent}/` : 'root'}
          </Text>
        </View>
        {snippet ? (
          <HighlightedText text={snippet} query={query} numberOfLines={2} style={s.snippet} />
        ) : null}
      </Pressable>
    )
  },
  (previous, next) =>
    previous.result.note === next.result.note &&
    previous.result.snippet === next.result.snippet &&
    previous.query === next.query &&
    previous.onPress === next.onPress &&
    previous.onLongPress === next.onLongPress
)

function Library() {
  const s = useStyles()
  const { top, right, bottom, left } = useSafeAreaInsets()
  const { colors, palette } = useTheme()
  const [vault, setVault] = useState<Vault | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [folders, setFolders] = useState<string[]>([''])
  const [folder, setFolder] = useState('')
  const [folderStack, setFolderStack] = useState<string[]>([''])
  const [restoring, setRestoring] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<{ uri: string; message: string } | null>(null)
  const [query, setQuery] = useState('')
  const queryRef = useRef(query)
  queryRef.current = query
  const [sort, setSort] = useState<NoteSort>('name-asc')
  const [sortOpen, setSortOpen] = useState(false)
  const [selected, setSelected] = useState<NoteSession | null>(null)
  const [prepared, setPrepared] = useState<NoteSession | null>(null)
  const pendingNote = useRef<NoteSession | null>(null)
  const openingScreen = useRef<'note' | 'new' | 'move' | 'appearance' | 'about' | null>(null)
  const libraryVisibleRef = useRef(true)
  const [backGate] = useState(() => new BackGate())
  const backFrame = useRef<number | null>(null)
  const noteSession = useRef(0)
  const detailNoteUri = useRef('')
  const openingStarted = useRef<{ session: number; at: number } | null>(null)
  const noticeSession = useRef(0)
  const skippedReport = useRef('')
  const [creating, setCreating] = useState(false)
  const [templateEditor, setTemplateEditor] = useState<{
    source: string
    onSaved: (source: string) => void
  } | null>(null)
  const creatingRef = useRef(false)
  creatingRef.current = creating
  const [moving, setMoving] = useState<MovingItem | null>(null)
  const [notice, setNotice] = useState<LibraryNotice | null>(null)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [favorites, setFavorites] = useState<string[]>([])
  const favoritesRef = useRef(favorites)
  favoritesRef.current = favorites
  const favoritesReady = useRef(false)
  const [trashNotice, setTrashNotice] = useState<{ id: number; title: string } | null>(null)
  const [trashUndo, setTrashUndo] = useState<TrashUndo | null>(null)
  const undoingTrash = useRef(false)
  const trashNoticeId = useRef(0)
  // Filesystem trashing runs one item at a time so ".trash" names stay unique.
  const trashQueue = useRef<Promise<void>>(Promise.resolve())
  // Paths the library keeps hidden while their move runs, so a scan that read
  // the item first cannot put it back.
  const trashing = useRef(new Set<string>())
  const settledTrash = useRef<string[]>([])
  const [templateCache, setTemplateCache] = useState<{ vault: string; source: string } | null>(null)
  const templateVersion = useRef(0)
  const compiler = useRef<CompilerHandle>(null)
  const listRefs = useRef(new Map<string, React.RefObject<FlatList<LibraryItem> | null>>())
  const listRefFor = useCallback((path: string) => {
    let ref = listRefs.current.get(path)
    if (!ref) {
      ref = { current: null }
      listRefs.current.set(path, ref)
    }
    return ref
  }, [])
  const generation = useRef(0)
  const mounted = useRef(true)
  const scanningRef = useRef(false)
  const scanDuration = useRef(0)
  const lastScanEnd = useRef(0)
  const vaultRef = useRef<Vault | null>(null)
  const busy = useRef(false)
  const modalWasOpen = useRef(false)
  const foreground = useRef(AppState.currentState === 'active')
  busy.current = restoring || picking

  const isTrashing = useCallback((path: string) => {
    for (const target of trashing.current) {
      if (path === target || path.startsWith(`${target}/`)) return true
    }
    return false
  }, [])
  const index = useCallback(
    async (target: Vault, options?: { quiet?: boolean }) => {
      if (scanningRef.current) return
      const quiet = options?.quiet === true
      const templateVersionAtStart = templateVersion.current
      const started = performance.now()
      let firstBatch = true
      const request = ++generation.current
      scanningRef.current = true
      // Moves that finished before this scan are now gone from disk.
      for (const path of settledTrash.current) trashing.current.delete(path)
      settledTrash.current = []
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
                  const visible = partial.filter((note) => !isTrashing(note.path))
                  setNotes(visible)
                  setFolders(foldersFromNotes(visible))
                }
              }
        )
        if (mounted.current && request === generation.current) {
          const scannedNotes = result.notes.filter((note) => !isTrashing(note.path))
          const scannedFolders = result.folders.filter((path) => !isTrashing(path))
          setNotes((previous) => reconcileNotes(previous, scannedNotes))
          setFolders((previous) => (sameList(previous, scannedFolders) ? previous : scannedFolders))
          if (templateVersion.current === templateVersionAtStart) {
            const templates = scannedNotes.filter((note) => isRootTemplate(note.path))
            const folder = scannedFolders.some((path) => path.toLowerCase() === 'template.typ')
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
                icon: 'fileAlert',
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
        scanDuration.current = performance.now() - started
        lastScanEnd.current = performance.now()
        if (mounted.current && request === generation.current) {
          scanningRef.current = false
          if (!quiet) setScanning(false)
        }
      }
    },
    [isTrashing]
  )

  const quietScan = useCallback(() => {
    const target = vaultRef.current
    if (!target || scanningRef.current || busy.current) return
    if (!foreground.current) return
    return index(target, { quiet: true })
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
          // The editor runtime needs no vault, so copy it while the index loads.
          void webRuntime('editor').catch(() => {})
          const [cached, savedFavorites] = await Promise.all([
            loadVaultIndex(saved),
            loadFavorites(saved),
          ])
          if (cancelled) return
          setFavorites(savedFavorites)
          favoritesReady.current = true
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
      if (state === 'active') void quietScan()
    })
    return () => listener.remove()
  }, [quietScan])

  useEffect(() => {
    const target = vaultRef.current
    if (!target || !favoritesReady.current) return
    const timer = setTimeout(() => {
      void storeFavorites(target, favorites).catch(() => {})
    }, 300)
    return () => clearTimeout(timer)
  }, [favorites])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      const wait = Math.max(15_000, scanDuration.current * 2)
      const idle = performance.now() - lastScanEnd.current
      if (idle < wait) {
        timer = setTimeout(run, wait - idle)
        return
      }
      await quietScan()
      if (cancelled) return
      timer = setTimeout(run, Math.max(15_000, scanDuration.current * 2))
    }
    timer = setTimeout(run, 15_000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [quietScan])

  useEffect(() => {
    const open = !!selected || creating || !!moving || appearanceOpen || aboutOpen
    if (modalWasOpen.current && !open) void quietScan()
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
      folderRows.current.clear()
      if (vaultRef.current?.uri !== next.uri) {
        trashing.current.clear()
        settledTrash.current = []
      }
      setVault(next)
      vaultRef.current = next
      setNotes([])
      setFolders([''])
      setFavorites([])
      setFolder('')
      setFolderStack([''])
      setTemplateCache(null)
      setMoving(null)
      setNotice(null)
      setPrepared(null)
      pendingNote.current = null
      openingScreen.current = null
      const cached = await loadVaultIndex(next)
      if (!mounted.current) return
      const cachedNotes = (cached ?? []).filter((note) => !isTrashing(note.path))
      setNotes(cachedNotes)
      setFolders(foldersFromNotes(cachedNotes))
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
  const searchBusy = searchPending || deferredQuery !== query
  const results = useMemo(() => {
    const current = new Map(notes.map((note) => [note.uri, note]))
    return searchResults.flatMap((result) => {
      const note = current.get(result.note.uri)
      return note ? [{ ...result, note }] : []
    })
  }, [notes, searchResults])
  const isSearching = query.trim().length > 0
  const sortOption =
    noteSorts.find((option) => option.ascValue === sort || option.descValue === sort) ??
    noteSorts[0]
  const sortLabel = `${sortOption.label}, ${sort === sortOption.ascValue ? sortOption.ascending : sortOption.descending}`
  useEffect(() => {
    // Results stay visible while the next search runs, so drop them when search ends.
    if (!isSearching) setResults((current) => (current.length ? [] : current))
  }, [isSearching])
  const searchInput = useRef<React.ComponentRef<typeof TextInput>>(null)
  useEffect(() => {
    // Keep focus state in sync with the keyboard so the list is not left shifted.
    const listener = Keyboard.addListener('keyboardDidHide', () => searchInput.current?.blur())
    return () => listener.remove()
  }, [])
  const searchRows = useMemo(() => {
    const rows: SearchRow[] = []
    const names = results.filter((result) => !result.snippet)
    const contents = results.filter((result) => !!result.snippet)
    if (names.length > 0) {
      rows.push({ kind: 'header', title: 'IN THE NAME', key: 'name-header' })
      for (const result of names) rows.push({ kind: 'result', result })
    }
    if (contents.length > 0) {
      rows.push({ kind: 'header', title: 'IN YOUR NOTES', key: 'content-header' })
      for (const result of contents) rows.push({ kind: 'result', result })
    }
    return rows
  }, [results])
  const notesByFolder = useMemo(() => {
    const map = new Map<string, Note[]>()
    for (const note of notes) {
      const parent = parentFolder(note.path)
      const list = map.get(parent)
      if (list) list.push(note)
      else map.set(parent, [note])
    }
    return map
  }, [notes])
  const foldersByParent = useMemo(() => {
    const map = new Map<string, FolderRowItem[]>()
    for (const path of folders) {
      if (!path) continue
      const parent = parentFolder(path)
      const item: FolderRowItem = { kind: 'folder', path, name: folderName(path) }
      const list = map.get(parent)
      if (list) list.push(item)
      else map.set(parent, [item])
    }
    return map
  }, [folders])
  const favoritePaths = useMemo(() => new Set(favorites), [favorites])
  const folderRows = useRef<FolderRowsCache>(new Map())
  const folderViews = useMemo(() => {
    return folderStack.map((path) => {
      const current = path === folder
      const childFolders = foldersByParent.get(path) ?? EMPTY_FOLDERS
      const items: LibraryItem[] = [
        ...childFolders,
        ...sortedNoteRows(folderRows.current, path, notesByFolder.get(path) ?? EMPTY_NOTES, sort),
      ]
      const isFavorite = (item: LibraryItem) =>
        favoritePaths.has(item.kind === 'folder' ? item.path : item.result.note.path)
      return {
        path,
        current,
        items: [...items.filter(isFavorite), ...items.filter((item) => !isFavorite(item))],
      }
    })
  }, [favoritePaths, folder, folderStack, foldersByParent, notesByFolder, sort])
  const crumbs = useMemo(() => {
    let path = ''
    return folder
      ? folder.split('/').map((name) => {
          path = path ? `${path}/${name}` : name
          return { name, path }
        })
      : []
  }, [folder])
  const clearSearch = useCallback(() => {
    if (!queryRef.current) return
    setQuery('')
  }, [])
  const stopIndex = useCallback(() => {
    generation.current++
    scanningRef.current = false
    setScanning(false)
  }, [])
  const goToFolder = useCallback(
    (path: string) => {
      if (path === folder || backGate.blockOpening()) return
      Keyboard.dismiss()
      searchInput.current?.blur()
      stopIndex()
      setFolderStack((stack) => {
        const index = stack.lastIndexOf(path)
        return index >= 0 ? stack.slice(0, index + 1) : [...stack, path]
      })
      setFolder(path)
    },
    [backGate, folder, stopIndex]
  )
  const toggleFavorite = useCallback((path: string) => {
    setFavorites((previous) =>
      previous.includes(path) ? previous.filter((item) => item !== path) : [...previous, path]
    )
  }, [])
  const moveToTrash = useCallback(
    (item: MovingItem) => {
      const target = vaultRef.current
      if (!target) return
      stopIndex()
      setError(null)
      const enqueue = (
        task: () => Promise<TrashedNote>,
        trashed: {
          noticeId: number
          path: string
          favorites: string[]
          notes: Note[]
          folders: string[]
        },
        moving: MovingItem
      ) => {
        let settle: (value: TrashedNote | null) => void = () => {}
        const result = new Promise<TrashedNote | null>((resolve) => {
          settle = resolve
        })
        setTrashUndo({
          noticeId: trashed.noticeId,
          item: moving,
          favorites: trashed.favorites,
          notes: trashed.notes,
          folders: trashed.folders,
          result,
        })
        trashQueue.current = trashQueue.current.then(async () => {
          try {
            const stored = await task()
            settle(stored)
            if (vaultRef.current?.uri === target.uri) settledTrash.current.push(trashed.path)
          } catch (cause) {
            settle(null)
            // The item is still on disk, so it comes back into the library.
            if (vaultRef.current?.uri === target.uri) trashing.current.delete(trashed.path)
            if (!mounted.current || vaultRef.current?.uri !== target.uri) return
            setTrashNotice((current) => (current?.id === trashed.noticeId ? null : current))
            setTrashUndo((current) => (current?.noticeId === trashed.noticeId ? null : current))
            if (trashed.favorites.length > 0) {
              setFavorites((previous) => [
                ...previous,
                ...trashed.favorites.filter((path) => !previous.includes(path)),
              ])
            }
            const failure = errorText(cause)
            // Read the vault again so the restored item reappears.
            await index(target, { quiet: true })
            if (!mounted.current || vaultRef.current?.uri !== target.uri) return
            setError(failure)
          }
        })
      }
      if (item.kind === 'folder') {
        const { entry } = item
        const prefix = `${entry.path}/`
        const inside = (path: string) => path === entry.path || path.startsWith(prefix)
        const removedFavorites = favoritesRef.current.filter(inside)
        const removedNotes = notes.filter((note) => inside(note.path))
        const removedFolders = folders.filter(inside)
        setNotes((previous) => previous.filter((note) => !inside(note.path)))
        setFolders((previous) => previous.filter((path) => !inside(path)))
        setFavorites((previous) => previous.filter((path) => !inside(path)))
        setPrepared((current) => (current && inside(current.note.path) ? null : current))
        setSelected((current) => (current && inside(current.note.path) ? null : current))
        if (pendingNote.current && inside(pendingNote.current.note.path)) {
          pendingNote.current = null
        }
        const notice = { id: ++trashNoticeId.current, title: entry.name }
        setTrashNotice(notice)
        trashing.current.add(entry.path)
        enqueue(
          () => trashFolder(target, entry.path),
          {
            noticeId: notice.id,
            path: entry.path,
            favorites: removedFavorites,
            notes: removedNotes,
            folders: removedFolders,
          },
          item
        )
        return
      }
      const { note } = item.result
      const removedFavorites = favoritesRef.current.filter((path) => path === note.path)
      if (isRootTemplate(note.path)) {
        templateVersion.current += 1
        setTemplateCache(null)
      }
      setNotes((previous) => previous.filter((item) => item.uri !== note.uri))
      setFavorites((previous) => previous.filter((path) => path !== note.path))
      setPrepared((current) => (current?.note.uri === note.uri ? null : current))
      setSelected((current) => (current?.note.uri === note.uri ? null : current))
      if (pendingNote.current?.note.uri === note.uri) pendingNote.current = null
      const notice = { id: ++trashNoticeId.current, title: note.title }
      setTrashNotice(notice)
      trashing.current.add(note.path)
      enqueue(
        () => trashNote(target, note),
        {
          noticeId: notice.id,
          path: note.path,
          favorites: removedFavorites,
          notes: [note],
          folders: [],
        },
        item
      )
    },
    [folders, index, notes, stopIndex]
  )
  const undoLastTrash = useCallback(() => {
    const pending = trashUndo
    const target = vaultRef.current
    if (!pending || !target || undoingTrash.current) return
    undoingTrash.current = true
    setError(null)
    const original =
      pending.item.kind === 'note' ? pending.item.result.note.path : pending.item.entry.path
    // Put the item back in the library immediately; the filesystem catches up.
    trashing.current.delete(original)
    settledTrash.current = settledTrash.current.filter((path) => path !== original)
    setNotes((previous) => {
      const next = new Map(previous.map((note) => [note.uri, note]))
      for (const note of pending.notes) next.set(note.uri, note)
      return [...next.values()].sort((a, b) => a.path.localeCompare(b.path))
    })
    if (pending.folders.length > 0) {
      setFolders((previous) =>
        [...new Set([...previous, ...pending.folders])].sort((a, b) => a.localeCompare(b))
      )
    }
    if (pending.favorites.length > 0) {
      setFavorites((previous) => [...new Set([...previous, ...pending.favorites])])
    }
    setTrashUndo(null)
    setTrashNotice(null)
    trashQueue.current = trashQueue.current
      .then(async () => {
        const trashed = await pending.result
        if (!trashed) {
          await index(target, { quiet: true })
          return
        }
        if (pending.item.kind === 'note') await restoreNote(target, trashed, original)
        else await restoreFolder(target, trashed, original)
        if (vaultRef.current?.uri === target.uri) await index(target, { quiet: true })
      })
      .catch((cause) => {
        if (!mounted.current || vaultRef.current?.uri !== target.uri) return
        if (pending.favorites.length > 0) {
          setFavorites((previous) => previous.filter((path) => !pending.favorites.includes(path)))
        }
        setError(errorText(cause))
        void index(target, { quiet: true })
      })
      .finally(() => {
        undoingTrash.current = false
      })
  }, [index, trashUndo])
  const settleBack = useCallback(
    (exit: boolean, drain = true) => {
      if (!backGate.begin(exit)) return
      if (!drain) {
        if (backGate.finish()) BackHandler.exitApp()
        return
      }
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
      else if (queryRef.current) {
        clearSearch()
        settleBack(false)
      } else if (folder) {
        goToFolder(parentFolder(folder))
        settleBack(false)
      } else settleBack(true)
      return true
    })
    return () => subscription.remove()
  }, [clearSearch, folder, goToFolder, settleBack, stopIndex])
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
  const updateNote = useCallback(
    (note: Note) => {
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
    },
    [stopIndex, vault]
  )
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
        showNotice('folderOpen', 'Note moved', moved.path)
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
      showNotice('folderOpen', 'Folder moved', moved.path)
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
  const openResult = useCallback((result: SearchResult) => void openNote(result), [openNote])
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
  const keyExtractor = useCallback(
    (item: LibraryItem) =>
      item.kind === 'folder' ? `folder:${item.path}` : `note:${item.result.note.uri}`,
    []
  )
  const renderLibraryItem = useCallback(
    ({ item }: { item: LibraryItem }) =>
      item.kind === 'folder' ? (
        <FolderRow
          entry={item}
          favorite={favoritePaths.has(item.path)}
          onPress={goToFolder}
          onLongPress={startMoveFolder}
          onToggleFavorite={favoriteFolderItem}
          onTrash={trashFolderItem}
        />
      ) : (
        <NoteRow
          result={item.result}
          favorite={favoritePaths.has(item.result.note.path)}
          onPressIn={prepareNote}
          onPress={openNote}
          onLongPress={startMoveNote}
          onToggleFavorite={favoriteNoteItem}
          onTrash={trashNoteItem}
        />
      ),
    [
      favoriteFolderItem,
      favoriteNoteItem,
      favoritePaths,
      goToFolder,
      openNote,
      prepareNote,
      startMoveFolder,
      startMoveNote,
      trashFolderItem,
      trashNoteItem,
    ]
  )

  const { workspace } = usePdfWorkspace({
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
  detailNoteUri.current = detail?.note.uri ?? ''
  const closeNote = useCallback(() => {
    settleBack(false, false)
    openingScreen.current = null
    stopIndex()
    pendingNote.current = null
    setSelected(null)
  }, [settleBack, stopIndex])
  const saveNoteError = useCallback((message: string) => {
    setSaveError({ uri: detailNoteUri.current, message })
  }, [])
  const searchResultsReady = useCallback((next: SearchResult[]) => {
    setResults(next)
  }, [])
  const searchError = useCallback((message: string) => {
    setResults([])
    setError(message)
  }, [])
  const noteVisible = !!selected
  const libraryVisible = !noteVisible && !creating && !moving && !appearanceOpen && !aboutOpen
  useLayoutEffect(() => {
    libraryVisibleRef.current = libraryVisible
  }, [libraryVisible])
  useEffect(() => {
    // The index is only a launch cache, so keep the editor's autosaves from
    // serializing the whole library behind a note. Write once it is covered.
    if (!vault || restoring || scanning || picking || !libraryVisible) return
    const timer = setTimeout(() => {
      void storeVaultIndex(vault, notes).catch(() => {})
    }, 300)
    return () => clearTimeout(timer)
  }, [vault, notes, restoring, scanning, picking, libraryVisible])
  const openCreate = () => {
    if (backGate.blockOpening()) return
    Keyboard.dismiss()
    setNotice(null)
    stopIndex()
    openingScreen.current = 'new'
    setCreating(true)
  }
  const stopSearch = () => {
    searchInput.current?.blur()
    Keyboard.dismiss()
    clearSearch()
  }
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
        {!vault ? (
          restoring ? (
            <View style={s.flex} />
          ) : (
            <ScrollView contentContainerStyle={s.onboarding} keyboardShouldPersistTaps="handled">
              <View style={s.onboardSpacer}>
                <View style={s.onboardArt}>
                  <View style={s.onboardPaper}>
                    <Text style={[s.onboardCode, { color: colors.accent }]}>
                      {'== Observations'}
                    </Text>
                    <View style={s.onboardCodeGap} />
                    <Text style={s.onboardCode}>Tide in early today.</Text>
                    <Text style={s.onboardCode}>Light on the water.</Text>
                    <View style={s.onboardCodeGap} />
                    <Text style={[s.onboardCode, { color: palette.yellow }]}>
                      {'$n -> infinity$'}
                    </Text>
                    <View style={s.onboardCodeGap} />
                    <Text style={[s.onboardCode, { color: palette.blue }]}>
                      {'#align(center)['}
                    </Text>
                    <Text style={[s.onboardCode, s.onboardCodeIndent]}>Still here.</Text>
                    <Text style={[s.onboardCode, { color: palette.blue }]}>{']'}</Text>
                    <Text style={[s.onboardCode, { color: palette.overlay2 }]}>
                      {'// begin here'}
                    </Text>
                  </View>
                  <View style={s.onboardPen}>
                    <Icon name="edit" size={25} color={colors.onAccent} />
                  </View>
                </View>
              </View>
              <Text style={s.onboardTitle}>{'Good things start\nwith a little note.'}</Text>
              <Text style={s.onboardBody}>
                Pick a folder to keep your notes in. They stay as plain .typ files you can open
                anywhere.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open a folder"
                disabled={picking}
                onPress={() => void chooseVault()}
                style={({ pressed }) => [
                  s.onboardButton,
                  pressed && s.pressed,
                  picking && s.disabled,
                ]}
              >
                <Icon name="folderOpen" size={22} color={colors.onAccent} />
                <Text style={s.onboardButtonText}>Open a folder</Text>
              </Pressable>
            </ScrollView>
          )
        ) : (
          <>
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
                <TypoMark size={34} />
                <Text style={s.brand}>Typo</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Notes folder: ${vault.name}. Choose folder`}
                disabled={picking}
                onPress={() => void chooseVault()}
                style={({ pressed }) => [
                  s.folderButton,
                  pressed && s.pressed,
                  picking && s.disabled,
                ]}
              >
                <Icon name="folderOpen" size={18} />
                <Text numberOfLines={1} style={s.folderName}>
                  {vault.name}
                </Text>
                <Icon name="swap" size={16} color={colors.muted} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Appearance settings"
                onPress={() => {
                  if (backGate.blockOpening()) return
                  Keyboard.dismiss()
                  openingScreen.current = 'appearance'
                  setAppearanceOpen(true)
                }}
                style={({ pressed }) => [s.headerButton, pressed && s.pressed]}
              >
                <Icon name="palette" size={24} />
              </Pressable>
            </View>
            {(error || saveError) && (
              <View style={s.errorInset}>
                {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
                {saveError && (
                  <ErrorBanner message={saveError.message} onDismiss={() => setSaveError(null)} />
                )}
              </View>
            )}
            <View style={s.flex}>
              {isSearching ? (
                <FlatList
                  style={s.flex}
                  data={searchRows}
                  keyExtractor={(item) =>
                    item.kind === 'header' ? item.key : `result:${item.result.note.uri}`
                  }
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="on-drag"
                  contentContainerStyle={[s.searchList, searchRows.length === 0 && s.emptyList]}
                  renderItem={({ item }) =>
                    item.kind === 'header' ? (
                      <Text accessibilityRole="header" style={s.searchGroup}>
                        {item.title}
                      </Text>
                    ) : (
                      <SearchResultRow
                        result={item.result}
                        query={query}
                        onPress={openResult}
                        onLongPress={startMoveNote}
                      />
                    )
                  }
                  ListEmptyComponent={
                    searchBusy ? (
                      <View style={s.empty}>
                        <Text style={s.emptyBody}>Searching…</Text>
                      </View>
                    ) : (
                      <View style={s.empty}>
                        <View style={s.emptyIcon}>
                          <Icon name="search" size={28} />
                        </View>
                        <Text style={s.emptyTitle}>No notes found.</Text>
                        <Pressable
                          accessibilityRole="button"
                          onPress={stopSearch}
                          style={s.textLink}
                        >
                          <Text style={s.linkText}>Clear search</Text>
                        </Pressable>
                      </View>
                    )
                  }
                />
              ) : (
                <>
                  {folder !== '' && (
                    <View style={s.crumbs}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Go to ${vault.name} root`}
                        hitSlop={12}
                        onPress={() => goToFolder('')}
                        style={({ pressed }) => [s.crumbHome, pressed && s.pressed]}
                      >
                        <Icon name="home" size={18} color={colors.muted} />
                      </Pressable>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={s.crumbScroll}
                      >
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Go to ${vault.name} root`}
                          hitSlop={{ top: 12, bottom: 12 }}
                          onPress={() => goToFolder('')}
                          style={({ pressed }) => [s.crumbButton, pressed && s.pressed]}
                        >
                          <Text numberOfLines={1} style={s.crumbText}>
                            {vault.name}
                          </Text>
                        </Pressable>
                        {crumbs.map((crumb, index) => (
                          <View key={crumb.path} style={s.crumbGroup}>
                            <Icon name="chevronRight" size={16} color={colors.muted} />
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Open folder ${crumb.path}`}
                              hitSlop={{ top: 12, bottom: 12 }}
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
                  <View style={s.flex}>
                    {folderViews.map((view, index) => (
                      <Reanimated.View
                        key={`folder:${view.path}`}
                        entering={view.path === '' ? undefined : folderIn}
                        exiting={view.path === '' ? undefined : folderOut}
                        style={
                          index === folderViews.length - 1 ? [s.flex, s.listLayer] : s.hiddenList
                        }
                        pointerEvents={view.current ? 'auto' : 'none'}
                        accessibilityElementsHidden={!view.current}
                        importantForAccessibility={view.current ? 'auto' : 'no-hide-descendants'}
                      >
                        <FlatList
                          ref={listRefFor(view.path)}
                          style={s.flex}
                          bounces={false}
                          alwaysBounceVertical={false}
                          overScrollMode="never"
                          initialNumToRender={12}
                          maxToRenderPerBatch={16}
                          updateCellsBatchingPeriod={16}
                          windowSize={5}
                          data={view.items}
                          keyExtractor={keyExtractor}
                          keyboardShouldPersistTaps="handled"
                          keyboardDismissMode="on-drag"
                          contentContainerStyle={[s.list, view.items.length === 0 && s.emptyList]}
                          renderItem={renderLibraryItem}
                          ListEmptyComponent={
                            !scanning ? (
                              <View style={s.empty}>
                                <View style={s.emptyIcon}>
                                  <Icon
                                    name={view.path ? 'folderOpen' : 'file'}
                                    size={32}
                                    color={view.path ? colors.accent : colors.ink}
                                  />
                                </View>
                                <Text style={s.emptyTitle}>
                                  {view.path ? 'This folder is empty.' : 'A fresh page awaits.'}
                                </Text>
                                <Text style={s.emptyBody}>
                                  {view.path
                                    ? 'Write a note here, or add .typ files to this folder.'
                                    : 'Create your first note, or add .typ files to this folder. They’ll feel right at home.'}
                                </Text>
                                <Pressable
                                  accessibilityRole="button"
                                  onPress={openCreate}
                                  style={({ pressed }) => [s.emptyButton, pressed && s.pressed]}
                                >
                                  <Icon name="plus" size={20} color={colors.onAccent} />
                                  <Text style={s.emptyButtonText}>
                                    {view.path ? 'Write a note here' : 'Write your first note'}
                                  </Text>
                                </Pressable>
                              </View>
                            ) : undefined
                          }
                        />
                      </Reanimated.View>
                    ))}
                  </View>
                </>
              )}
              <View pointerEvents="none" style={s.listFade}>
                <Fade id="library-fade" color={colors.paper} />
              </View>
            </View>
            <KeyboardAvoidingView behavior={keyboardBehavior} style={s.dockShell}>
              <View style={s.dock}>
                <View style={[s.searchField, isSearching && s.searchFieldActive]}>
                  <Icon name="search" size={22} color={colors.accent} />
                  <TextInput
                    ref={searchInput}
                    accessibilityLabel="Find a thought"
                    placeholder="Find a thought…"
                    placeholderTextColor={colors.muted}
                    value={query}
                    onChangeText={setQuery}
                    style={s.searchFieldInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                  />
                  {isSearching ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Clear search"
                      hitSlop={8}
                      onPress={() => {
                        setQuery('')
                        searchInput.current?.focus()
                      }}
                      style={s.searchFieldAction}
                    >
                      <Icon name="closeCircle" size={22} color={colors.muted} />
                    </Pressable>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Sort notes. ${sortLabel}`}
                      hitSlop={8}
                      onPress={() => {
                        Keyboard.dismiss()
                        searchInput.current?.blur()
                        setSortOpen(true)
                      }}
                      style={s.searchFieldAction}
                    >
                      <Icon name="sort" size={22} color={colors.muted} />
                    </Pressable>
                  )}
                </View>
                {isSearching ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel search"
                    onPress={stopSearch}
                    style={({ pressed }) => [s.cancelSearch, pressed && s.pressed]}
                  >
                    <Text style={s.cancelSearchText}>Cancel</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Create a new note"
                    onPress={openCreate}
                    style={({ pressed }) => [s.fab, pressed && s.fabPressed]}
                  >
                    <Icon name="plus" size={32} color={colors.onAccent} />
                  </Pressable>
                )}
              </View>
            </KeyboardAvoidingView>
            {trashNotice ? (
              <TrashNotice
                key={trashNotice.id}
                title={trashNotice.title}
                onUndo={
                  trashUndo?.noticeId === trashNotice.id ? () => void undoLastTrash() : undefined
                }
                onDone={() => setTrashNotice(null)}
              />
            ) : notice ? (
              <LibraryNotice key={notice.id} notice={notice} onDone={() => setNotice(null)} />
            ) : null}
          </>
        )}
      </View>
      {vault && (
        <MemoNoteSearch
          key={`search:${vault.uri}`}
          notes={notes}
          query={deferredQuery}
          mode={SEARCH_MODE}
          onResults={searchResultsReady}
          onError={searchError}
          onPending={setSearchPending}
        />
      )}
      {workspace && <MemoCompilerHost key={vault?.uri} ref={compiler} />}
      {vault && workspace && (
        <MemoNoteDetail
          key={`detail:${vault.uri}`}
          workspace={workspace}
          active={noteVisible}
          instantIn={!!selected?.created}
          onPrepared={editorPrepared}
          session={detail?.session ?? 0}
          note={detail?.note ?? warmNote}
          opening={!!selected?.opening}
          openError={selected?.openError}
          initialLine={detail?.line}
          initialQuery={isSearching && detail?.line ? query : ''}
          onClose={closeNote}
          onSave={updateNote}
          onSaveError={saveNoteError}
        />
      )}
      {creating && vault && (
        <NewNote
          vault={vault}
          folders={folders}
          directory={folder}
          initialTemplate={templateCache?.vault === vault.uri ? templateCache.source : undefined}
          onFolderCreated={folderCreated}
          onEditTemplate={(source, onSaved) => setTemplateEditor({ source, onSaved })}
          obscured={!!templateEditor}
          onClose={() => {
            settleBack(false, false)
            openingScreen.current = null
            setCreating(false)
          }}
          onCreated={(note) => {
            stopIndex()
            setNotes((previous) => [...previous, note].sort((a, b) => a.path.localeCompare(b.path)))
            clearSearch()
            openingScreen.current = 'note'
            setSelected({ ...prepareNote({ note }), created: true })
          }}
          onDismissed={() => setCreating(false)}
        />
      )}
      {templateEditor && vault && (
        <TemplateEditor
          vault={vault}
          source={templateEditor.source}
          onClose={() => setTemplateEditor(null)}
          onSaved={(source) => {
            const pending = templateEditor
            setTemplateEditor(null)
            pending.onSaved(source)
            templateVersion.current += 1
            setTemplateCache({ vault: vault.uri, source })
            void index(vault, { quiet: true })
          }}
        />
      )}
      {moving && vault && (
        <FolderSheet
          folders={folders}
          vault={vault}
          initial={null}
          exclude={moving.kind === 'folder' ? parentFolder(moving.entry.path) : undefined}
          excludeTree={moving.kind === 'folder' ? moving.entry.path : undefined}
          defaultParent={moving.kind === 'folder' ? parentFolder(moving.entry.path) : folder}
          title={moving.kind === 'folder' ? 'Move folder' : 'Move note'}
          mode="move"
          itemName={
            moving.kind === 'note'
              ? moving.result.note.path.slice(moving.result.note.path.lastIndexOf('/') + 1)
              : moving.entry.name
          }
          itemIcon={moving.kind === 'note' ? 'file' : 'folder'}
          confirmLabel="Move here"
          busyLabel="Moving…"
          onConfirm={moveTo}
          onFolderCreated={folderCreated}
          onClose={() => {
            settleBack(false, false)
            openingScreen.current = null
            setMoving(null)
          }}
        />
      )}
      {aboutOpen && (
        <AboutSheet
          onClose={() => {
            settleBack(false, false)
            openingScreen.current = null
            setAboutOpen(false)
          }}
        />
      )}
      {appearanceOpen && (
        <AppearanceSettings
          onClose={() => {
            settleBack(false, false)
            openingScreen.current = null
            setAppearanceOpen(false)
          }}
        />
      )}
      {sortOpen && (
        <SortSheet
          sort={sort}
          onChange={(value) => {
            if (value === sort) return
            setSort(value)
            listRefs.current.get(folder)?.current?.scrollToOffset({
              offset: 0,
              animated: false,
            })
          }}
          onClose={() => setSortOpen(false)}
        />
      )}
    </View>
  )
}

function SwipeRow({
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
  const { colors } = useTheme()
  const translation = useSharedValue(0)
  const start = useSharedValue(0)
  const side = useSharedValue<RowAction | null>(null)
  // A long press owns the touch until release, so the swipe stays inert.
  const hold = useSharedValue(false)
  const swiped = useRef(false)
  const longPressed = useRef(false)
  const held = useRef(false)
  const paneRef = useRef<RowAction | null>(null)
  const [pane, setPane] = useState<RowAction | null>(null)
  const [armed, setArmed] = useState<RowAction | null>(null)
  const live = useRef({
    onPressIn,
    onPress,
    onLongPress,
    onToggleFavorite,
    onTrash,
  })
  live.current = {
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
  const swipeTrash = useCallback(() => {
    if (held.current) return
    live.current.onTrash()
  }, [])
  const swipeFavorite = useCallback(() => {
    if (held.current) return
    live.current.onToggleFavorite()
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
        .onBegin(() => {
          'worklet'
          hold.value = false
        })
        .onStart(() => {
          'worklet'
          start.value = translation.value
          side.value = null
          runOnJS(markSwiped)()
        })
        .onUpdate((event) => {
          'worklet'
          if (hold.value) return
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
          if (locked && !hold.value) {
            const projected = start.value + event.translationX + event.velocityX * SWIPE_TOSS
            if (locked === 'trash' && projected <= -SWIPE_TRASH_DISTANCE) {
              runOnJS(swipeTrash)()
            } else if (locked === 'favorite' && projected >= SWIPE_FAVORITE_DISTANCE) {
              runOnJS(swipeFavorite)()
            }
          }
          translation.value = spring(0, SWIPE_SPRING, (finished) => {
            'worklet'
            if (finished) runOnJS(hidePane)()
          })
        })
        .onFinalize((_event, success) => {
          'worklet'
          if (!success) {
            translation.value = spring(0, SWIPE_SPRING, (finished) => {
              'worklet'
              if (finished) runOnJS(hidePane)()
            })
          }
          side.value = null
        }),
    [hidePane, hold, markSwiped, showPane, side, start, swipeFavorite, swipeTrash, translation]
  )
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
  const foregroundStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translation.value }],
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
    live.current.onPress()
  }
  const hint = `Swipe right and release to favorite this ${noun}, or swipe left and release to move it to trash.`
  return (
    <View style={[s.swipeShell, pane !== null && s.swipeClipped]}>
      <GestureDetector gesture={pan}>
        <Reanimated.View
          style={[s.swipeForeground, foregroundStyle]}
          renderToHardwareTextureAndroid
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={`${hint} Long press to move this ${noun}.`}
            accessibilityActions={[
              { name: 'favorite', label: favorite ? 'Remove from favorites' : 'Add to favorites' },
              { name: 'trash', label: 'Move to trash' },
              { name: 'move', label: 'Move to folder' },
            ]}
            onAccessibilityAction={(event) => {
              const action = event.nativeEvent.actionName
              if (action === 'favorite') live.current.onToggleFavorite()
              else if (action === 'trash') live.current.onTrash()
              else if (action === 'move') live.current.onLongPress()
            }}
            delayLongPress={350}
            onPressIn={() => {
              swiped.current = false
              longPressed.current = false
              held.current = false
              live.current.onPressIn?.()
            }}
            onLongPress={() => {
              if (swiped.current) return
              longPressed.current = true
              held.current = true
              hold.value = true
              live.current.onLongPress()
            }}
            onPress={press}
            style={({ pressed }) => [s.noteRow, pressed && s.rowPressed]}
          >
            {children}
          </Pressable>
        </Reanimated.View>
      </GestureDetector>
      {pane === 'favorite' ? (
        <Reanimated.View
          renderToHardwareTextureAndroid
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[s.swipeAction, s.swipeFavoritePane]}
        >
          <Reanimated.View style={[s.swipeActionContent, favoriteContentStyle]}>
            <View style={s.swipeConfirm}>
              <SwapIcon
                from="star"
                to="star"
                active={armed === 'favorite'}
                size={21}
                color={colors.accent}
                fromFill="none"
                toFill={colors.accent}
              />
            </View>
            <SwapLabel
              idle={favorite ? 'UNFAVORITE' : 'FAVORITE'}
              activeLabel="RELEASE"
              active={armed === 'favorite'}
              style={[s.swipeActionLabel, { color: colors.onAccent }]}
            />
          </Reanimated.View>
        </Reanimated.View>
      ) : null}
      {pane === 'trash' ? (
        <Reanimated.View
          renderToHardwareTextureAndroid
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[s.swipeAction, s.swipeTrashPane]}
        >
          <Reanimated.View style={[s.swipeActionContent, trashContentStyle]}>
            <View style={s.swipeConfirm}>
              <SwapIcon
                from="trash"
                to="trashOpen"
                active={armed === 'trash'}
                size={20}
                color={colors.ink}
              />
            </View>
            <SwapLabel
              idle="TRASH"
              activeLabel="RELEASE"
              active={armed === 'trash'}
              style={[s.swipeActionLabel, { color: colors.paper }]}
            />
          </Reanimated.View>
        </Reanimated.View>
      ) : null}
    </View>
  )
}

const NoteRow = memo(
  function NoteRow({
    result,
    favorite,
    onPressIn,
    onPress,
    onLongPress,
    onToggleFavorite,
    onTrash,
  }: {
    result: SearchResult
    favorite: boolean
    onPressIn: (result: SearchResult) => void
    onPress: (result: SearchResult) => void
    onLongPress: (result: SearchResult) => void
    onToggleFavorite: (result: SearchResult) => void
    onTrash: (result: SearchResult) => void
  }) {
    const s = useStyles()
    const { colors } = useTheme()
    const { note, snippet } = result
    return (
      <SwipeRow
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
          <Icon name="file" size={22} />
        </View>
        <View style={s.noteInfo}>
          <Text numberOfLines={1} style={s.noteTitle}>
            {note.title}
          </Text>
          <Text numberOfLines={1} style={s.rowPath}>
            {note.path}
          </Text>
          {snippet ? (
            <Text numberOfLines={2} style={s.snippet}>
              {snippet.trim()}
            </Text>
          ) : null}
        </View>
        {favorite ? (
          <Icon name="star" size={18} color={colors.accent} fill={colors.accent} />
        ) : null}
        <Icon name="chevronRight" size={20} color={colors.muted} />
      </SwipeRow>
    )
  },
  (previous, next) =>
    previous.result.note === next.result.note &&
    previous.result.snippet === next.result.snippet &&
    previous.result.line === next.result.line &&
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
    favorite,
    onPress,
    onLongPress,
    onToggleFavorite,
    onTrash,
  }: {
    entry: FolderEntry
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
        favorite={favorite}
        noun="folder"
        label={`Folder ${entry.name}`}
        onPress={() => onPress(entry.path)}
        onLongPress={() => onLongPress(entry)}
        onToggleFavorite={() => onToggleFavorite(entry)}
        onTrash={() => onTrash(entry)}
      >
        <View style={s.folderGlyph}>
          <Icon name="folder" size={22} color={colors.accent} />
        </View>
        <View style={s.noteInfo}>
          <Text numberOfLines={1} style={s.noteTitle}>
            {entry.name}
          </Text>
        </View>
        {favorite ? (
          <Icon name="star" size={18} color={colors.accent} fill={colors.accent} />
        ) : null}
        <Icon name="chevronRight" size={20} color={colors.muted} />
      </SwipeRow>
    )
  },
  (previous, next) =>
    previous.entry.path === next.entry.path &&
    previous.entry.name === next.entry.name &&
    previous.favorite === next.favorite &&
    previous.onPress === next.onPress &&
    previous.onLongPress === next.onLongPress &&
    previous.onToggleFavorite === next.onToggleFavorite &&
    previous.onTrash === next.onTrash
)

function useNoticeMotion(onDone: () => void, duration = 3200) {
  const opacity = useSharedValue(0)
  const done = useRef(onDone)
  done.current = onDone
  const alive = useRef(true)
  const notify = useCallback(() => {
    if (alive.current) done.current()
  }, [])
  useEffect(() => {
    alive.current = true
    opacity.value = timing(1, { duration: 180 })
    const timer = setTimeout(() => {
      opacity.value = timing(0, { duration: 180 }, (finished) => {
        'worklet'
        if (finished) runOnJS(notify)()
      })
    }, duration)
    return () => {
      alive.current = false
      clearTimeout(timer)
      opacity.value = 0
    }
  }, [duration, notify, opacity])
  return useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: (1 - opacity.value) * 10 }],
  }))
}

function LibraryNotice({ notice, onDone }: { notice: LibraryNotice; onDone: () => void }) {
  const s = useStyles()
  const { colors } = useTheme()
  const motion = useNoticeMotion(onDone)
  return (
    <Reanimated.View
      accessibilityLiveRegion="polite"
      pointerEvents="none"
      style={[s.notice, motion]}
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
    </Reanimated.View>
  )
}

function TrashNotice({
  title,
  onUndo,
  onDone,
}: {
  title: string
  onUndo?: () => void
  onDone: () => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const motion = useNoticeMotion(onDone, onUndo ? 5000 : 3200)
  return (
    <Reanimated.View accessibilityLiveRegion="polite" style={[s.trashNotice, motion]}>
      <View style={s.trashNoticeIcon}>
        <Icon name="trash" size={20} color={colors.onAccent} />
      </View>
      <View style={s.flex}>
        <Text style={s.trashNoticeTitle}>Moved to trash</Text>
        <Text numberOfLines={1} style={s.trashNoticeBody}>
          {title}
        </Text>
      </View>
      {onUndo ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo move to trash"
          onPress={onUndo}
          style={({ pressed }) => [s.trashUndo, pressed && s.pressed]}
        >
          <Text style={s.trashUndoText}>Undo</Text>
        </Pressable>
      ) : null}
    </Reanimated.View>
  )
}

type FolderNode = { path: string; name: string; children: FolderNode[] }

function FolderSheet({
  folders,
  vault,
  initial,
  exclude,
  excludeTree,
  defaultParent,
  mode = 'browse',
  title,
  confirmLabel,
  busyLabel,
  itemName,
  itemIcon = 'file',
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
  mode?: 'browse' | 'move' | 'create-in'
  title: string
  confirmLabel: string
  busyLabel?: string
  itemName?: string
  itemIcon?: IconName
  onConfirm: (destination: string) => Promise<void>
  onClose: () => void
  onFolderCreated: (folder: NoteFolder) => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const vaultName = vault.name
  const [destination, setDestination] = useState<string | null>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newPath, setNewPath] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const allowed = useMemo(
    () =>
      folders.filter(
        (path) =>
          (exclude === undefined || path !== exclude) &&
          (excludeTree === undefined ||
            (path !== excludeTree && !path.startsWith(`${excludeTree}/`)))
      ),
    [folders, exclude, excludeTree]
  )
  const tree = useMemo(() => {
    const nodes = new Map<string, FolderNode>()
    const root: FolderNode = { path: '', name: vaultName, children: [] }
    nodes.set('', root)
    const ensure = (path: string): FolderNode => {
      const existing = nodes.get(path)
      if (existing) return existing
      const node: FolderNode = { path, name: folderName(path), children: [] }
      nodes.set(path, node)
      const parent = ensure(parentFolder(path))
      parent.children.push(node)
      return node
    }
    for (const path of allowed) {
      if (!path) continue
      ensure(path)
    }
    for (const node of nodes.values()) node.children.sort((a, b) => a.name.localeCompare(b.name))
    return root
  }, [allowed, vaultName])
  const rows = useMemo(() => {
    const list: { node: FolderNode; level: number }[] = []
    const walk = (node: FolderNode, level: number, isRoot: boolean) => {
      list.push({ node, level })
      if (!isRoot && collapsed.has(node.path)) return
      for (const child of node.children) walk(child, isRoot ? 0 : level + 1, false)
    }
    walk(tree, 0, true)
    return list
  }, [collapsed, tree])
  const chosenName = destination === null ? '' : destination ? folderName(destination) : vaultName
  const move = mode === 'move'
  const createIn = mode === 'create-in'
  const actionLabel =
    busy && busyLabel
      ? busyLabel
      : move && chosenName
        ? `Move to ${chosenName}`
        : createIn && chosenName
          ? `Create in ${chosenName}`
          : confirmLabel
  const toggle = (path: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
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
    <>
      <BottomSheet title={title} busy={busy} onClose={onClose}>
        {itemName ? (
          <View style={s.folderFileRow}>
            <Icon name={itemIcon} size={16} color={colors.muted} />
            <Text numberOfLines={1} style={s.folderFileName}>
              {itemName}
            </Text>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Create a new folder in ${(destination ?? defaultParent) || vaultName}`}
          disabled={busy}
          onPress={() => setNewFolderOpen(true)}
          style={({ pressed }) => [s.folderNewRow, pressed && s.pressed, busy && s.disabled]}
        >
          <Icon name="plus" size={22} color={colors.accent} />
          <Text style={s.folderNewText}>New folder</Text>
        </Pressable>
        <View style={s.folderDivider} />
        <ScrollView style={s.folderTree} contentContainerStyle={s.folderTreeContent}>
          {rows.map(({ node, level }) => {
            const current = defaultParent !== undefined && node.path === defaultParent
            const selected = destination === node.path
            const hasChildren = node.children.length > 0
            const open = !collapsed.has(node.path)
            return (
              <View
                key={node.path || 'root'}
                style={[
                  s.folderTreeRow,
                  { paddingLeft: 8 + level * 28 },
                  selected && s.folderTreeRowSelected,
                ]}
              >
                {node.path === '' ? (
                  <View style={s.folderChevron} />
                ) : hasChildren ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
                    hitSlop={12}
                    onPress={() => toggle(node.path)}
                    style={s.folderChevron}
                  >
                    <Icon
                      name={open ? 'chevronDown' : 'chevronRight'}
                      size={20}
                      color={colors.muted}
                    />
                  </Pressable>
                ) : (
                  <View style={s.folderChevron} />
                )}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityLabel={`${node.name}${current ? ', current' : ''}`}
                  accessibilityState={{ checked: selected }}
                  disabled={busy || current}
                  onPress={() => {
                    setDestination(node.path)
                    setError(null)
                  }}
                  style={({ pressed }) => [s.folderTreeButton, pressed && s.pressed]}
                >
                  <Icon
                    name={node.path === '' ? 'home' : 'folder'}
                    size={22}
                    color={selected ? colors.accent : colors.muted}
                  />
                  <Text
                    numberOfLines={1}
                    style={[
                      s.folderTreeName,
                      selected && s.folderTreeNameSelected,
                      current && s.folderTreeNameCurrent,
                    ]}
                  >
                    {node.name}
                  </Text>
                  {current ? <Text style={s.folderCurrent}>Current</Text> : null}
                  {newPath === node.path ? <Text style={s.folderNewTag}>New</Text> : null}
                  {selected ? <Icon name="check" size={22} color={colors.accent} /> : null}
                </Pressable>
              </View>
            )
          })}
        </ScrollView>
        {error ? (
          <View style={s.sheetError}>
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          disabled={destination === null || busy}
          onPress={() => void confirm()}
          style={({ pressed }) => [
            s.moveButton,
            pressed && s.pressed,
            (destination === null || busy) && s.disabled,
          ]}
        >
          <Text style={s.moveButtonText}>{actionLabel}</Text>
        </Pressable>
      </BottomSheet>
      {newFolderOpen && (
        <NewFolderSheet
          vault={vault}
          folders={folders}
          initialParent={destination ?? defaultParent ?? ''}
          onClose={() => setNewFolderOpen(false)}
          onFolderCreated={onFolderCreated}
          onCreated={(folder) => {
            setDestination(folder.path)
            setNewPath(folder.path)
            setNewFolderOpen(false)
          }}
          onOpenFolder={(path) => {
            setDestination(path)
            setNewFolderOpen(false)
          }}
        />
      )}
    </>
  )
}

type NewFolderProblem =
  | { kind: 'slash'; index: number; name: string; sub: string }
  | { kind: 'exists'; index: number; name: string; path: string }

function NewFolderSheet({
  vault,
  folders,
  initialParent,
  onClose,
  onCreated,
  onFolderCreated,
  onOpenFolder,
}: {
  vault: Vault
  folders: string[]
  initialParent: string
  onClose: () => void
  onCreated: (folder: NoteFolder) => void
  onFolderCreated: (folder: NoteFolder) => void
  onOpenFolder: (path: string) => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const [parent, setParent] = useState(initialParent)
  const [segments, setSegments] = useState<{ id: number; value: string }[]>([{ id: 0, value: '' }])
  const nextSegment = useRef(1)
  const [focusIndex, setFocusIndex] = useState(0)
  const [focused, setFocused] = useState<number | null>(0)
  const segmentRefs = useRef(new Map<number, React.ComponentRef<typeof TextInput>>())
  const pendingFocus = useRef<number | null>(null)
  useEffect(() => {
    const id = pendingFocus.current
    if (id === null) return
    pendingFocus.current = null
    const input = segmentRefs.current.get(id)
    if (!input) return
    input.focus()
    setFocused(segments.findIndex((segment) => segment.id === id))
  }, [segments])
  const [choosingParent, setChoosingParent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<NewFolderProblem | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const names = segments.map((segment) => segment.value.trim())
  const slashIndex = segments.findIndex((segment) => segment.value.includes('/'))
  const liveProblem: NewFolderProblem | null =
    slashIndex >= 0
      ? {
          kind: 'slash',
          index: slashIndex,
          name: segments[slashIndex].value,
          sub: segments[slashIndex].value.split('/').filter(Boolean).at(-1) ?? '',
        }
      : problem
  const allFolders = useMemo(
    () => [
      { path: '', name: vault.name, depth: 0 },
      ...folders.filter(Boolean).map((path) => ({
        path,
        name: folderName(path),
        depth: path.split('/').length - 1,
      })),
    ],
    [folders, vault.name]
  )
  const parentParts = parent ? parent.split('/').filter(Boolean) : []
  const pathParts = [...parentParts, ...names.filter(Boolean)]
  const totalFolders = pathParts.length - parentParts.length
  const canCreate =
    !busy && !failure && !liveProblem && names.length > 0 && names.every((name) => name.length > 0)
  const actionLabel = totalFolders > 1 ? `Create ${totalFolders} folders` : 'Create folder'
  const parentPath = parent ? [vault.name, ...parentParts].join(' / ') : 'Vault root'
  const closeOrBack = () => {
    if (choosingParent) setChoosingParent(false)
    else onClose()
  }
  const updateSegment = (index: number, value: string) => {
    setSegments((previous) =>
      previous.map((segment, at) => (at === index ? { ...segment, value } : segment))
    )
    setProblem(null)
    setFailure(null)
  }
  const addSubfolder = () => {
    const id = nextSegment.current++
    setSegments((previous) => [...previous, { id, value: '' }])
    setFocusIndex(segments.length)
    pendingFocus.current = id
    setProblem(null)
  }
  const removeSegment = (index: number) => {
    const target = segments[Math.max(0, index - 1)]
    setSegments((previous) => previous.filter((_, at) => at !== index))
    setFocusIndex(Math.max(0, index - 1))
    setFocused(index > 0 ? index - 1 : 0)
    if (target) pendingFocus.current = target.id
    setProblem(null)
  }
  const makeSubfolder = () => {
    if (liveProblem?.kind !== 'slash') return
    const parts = names[liveProblem.index].split('/').map((part) => part.trim())
    if (parts.length < 2) return
    const index = liveProblem.index
    const [first, ...rest] = parts
    const subId = nextSegment.current++
    const added = rest.map((part, at) => ({
      id: at === 0 ? subId : nextSegment.current++,
      value: part,
    }))
    setSegments((previous) => {
      const next = [...previous]
      const original = next[index]
      next.splice(index, 1, { ...original, value: first }, ...added)
      return next
    })
    setProblem(null)
    setFocusIndex(index + 1)
    pendingFocus.current = subId
  }
  const applyTwo = () => {
    if (liveProblem?.kind !== 'exists') return
    const name = `${liveProblem.name} 2`
    const segment = segments[liveProblem.index]
    setSegments((previous) =>
      previous.map((entry, at) => (at === liveProblem.index ? { ...entry, value: name } : entry))
    )
    setProblem(null)
    setFocusIndex(liveProblem.index)
    if (segment) pendingFocus.current = segment.id
  }
  async function createFolders() {
    if (!canCreate) return
    setBusy(true)
    setFailure(null)
    setProblem(null)
    let currentParent = parent
    let final: NoteFolder | null = null
    for (const [index, name] of names.entries()) {
      try {
        const created = await createFolder(vault, name, currentParent)
        onFolderCreated(created)
        currentParent = created.path
        final = created
      } catch (cause) {
        const message = errorText(cause)
        const existing = /folder named "([^"]+)" already exists/iu.exec(message)
        if (existing && alive.current) {
          const path = currentParent ? `${currentParent}/${existing[1]}` : existing[1]
          setProblem({ kind: 'exists', index, name: existing[1], path })
        } else if (alive.current) {
          setFailure(message)
        }
        setBusy(false)
        return
      }
    }
    if (alive.current && final) {
      setBusy(false)
      onCreated(final)
    }
  }
  return (
    <BottomSheet
      title={choosingParent ? 'Choose parent' : 'New folder'}
      busy={busy}
      onClose={onClose}
      onRequestClose={() => {
        if (choosingParent) {
          setChoosingParent(false)
          return true
        }
        return false
      }}
      leading={<IconButton name="arrowLeft" label="Back" onPress={closeOrBack} disabled={busy} />}
    >
      <ScrollView
        style={s.folderNewScroll}
        contentContainerStyle={s.folderNewContent}
        keyboardShouldPersistTaps="handled"
      >
        {choosingParent ? (
          <>
            <Text style={s.folderFieldLabel}>CREATE FOLDER IN</Text>
            <Text style={s.sheetParentHint}>
              Choose any folder. The new folder is created inside it.
            </Text>
            {allFolders.map((item) => {
              const selected = parent === item.path
              return (
                <Pressable
                  key={item.path || 'root'}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => {
                    setParent(item.path)
                    setChoosingParent(false)
                  }}
                  style={({ pressed }) => [
                    s.sheetRow,
                    { paddingLeft: 20 + item.depth * 16 },
                    selected && s.sheetRowSelected,
                    pressed && s.rowPressed,
                  ]}
                >
                  <Icon
                    name={item.path ? 'folder' : 'home'}
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
                    name={selected ? 'checkCircle' : 'circle'}
                    size={21}
                    color={selected ? colors.accent : colors.muted}
                  />
                </Pressable>
              )
            })}
          </>
        ) : (
          <>
            <Text style={s.folderFieldLabel}>PARENT FOLDER</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Choose parent. Currently ${parentPath}`}
              onPress={() => setChoosingParent(true)}
              style={({ pressed }) => [s.folderParentRow, pressed && s.pressed]}
            >
              <Icon name={parent ? 'folder' : 'home'} size={22} color={colors.accent} />
              <View style={s.flex}>
                <Text numberOfLines={1} style={s.folderParentName}>
                  {parent ? folderName(parent) : vault.name}
                </Text>
                <Text numberOfLines={1} style={s.folderParentPath}>
                  {parentPath}
                </Text>
              </View>
              <Icon name="chevronRight" size={20} color={colors.muted} />
            </Pressable>
            <Text style={s.folderFieldLabel}>NAME</Text>
            <View style={s.folderSegments}>
              {segments.map((segment, index) => {
                const hasError = liveProblem?.index === index
                const sub = index > 0
                return (
                  <View
                    key={segment.id}
                    style={[s.folderSegmentWrap, sub && s.folderSegmentWrapSub]}
                  >
                    {sub ? <View style={s.folderSegmentBracket} /> : null}
                    <View
                      style={[
                        s.folderSegmentRow,
                        focused === index && s.folderSegmentRowFocused,
                        hasError && s.folderSegmentRowError,
                      ]}
                    >
                      <Icon
                        name="folder"
                        size={20}
                        color={hasError ? colors.coral : colors.accent}
                      />
                      <TextInput
                        ref={(input) => {
                          if (input) segmentRefs.current.set(segment.id, input)
                          else segmentRefs.current.delete(segment.id)
                        }}
                        accessibilityLabel={`Folder name${sub ? ` part ${index + 1}` : ''}`}
                        autoFocus={index === focusIndex}
                        value={segment.value}
                        onChangeText={(value) => updateSegment(index, value)}
                        onFocus={() => setFocused(index)}
                        onBlur={() => setFocused((current) => (current === index ? null : current))}
                        editable={!busy}
                        maxLength={120}
                        placeholder="Folder name"
                        placeholderTextColor={colors.muted}
                        returnKeyType="done"
                        onSubmitEditing={() => void createFolders()}
                        autoCorrect={false}
                        autoCapitalize="none"
                        cursorColor={colors.accent}
                        style={s.folderSegmentInput}
                      />
                      {hasError ? <Icon name="alert" size={20} color={colors.coral} /> : null}
                      {sub ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Remove subfolder"
                          hitSlop={10}
                          disabled={busy}
                          onPress={() => removeSegment(index)}
                          style={s.folderSegmentRemove}
                        >
                          <Icon name="close" size={20} color={colors.muted} />
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                )
              })}
            </View>
            {liveProblem ? (
              <View style={s.folderErrorCard} accessibilityRole="alert">
                <View style={s.folderErrorHeader}>
                  <Icon name="alert" size={20} color={colors.coral} />
                  <Text style={s.folderErrorText}>
                    {liveProblem.kind === 'slash'
                      ? "Folder names can't contain slashes."
                      : `A folder named "${liveProblem.name}" already exists here.`}
                  </Text>
                </View>
                <View style={s.folderErrorActions}>
                  {liveProblem.kind === 'slash' ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={makeSubfolder}
                      style={({ pressed }) => [s.folderErrorButton, pressed && s.pressed]}
                    >
                      <Text style={s.folderErrorButtonText}>
                        {`Make "${liveProblem.sub}" a subfolder`}
                      </Text>
                    </Pressable>
                  ) : (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        onPress={applyTwo}
                        style={({ pressed }) => [s.folderErrorButton, pressed && s.pressed]}
                      >
                        <Text style={s.folderErrorButtonText}>{`Use "${liveProblem.name} 2"`}</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => onOpenFolder(liveProblem.path)}
                        style={({ pressed }) => [s.folderErrorButton, pressed && s.pressed]}
                      >
                        <Text style={s.folderErrorButtonText}>{`Open ${liveProblem.name}`}</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add a subfolder"
              disabled={busy}
              onPress={addSubfolder}
              style={({ pressed }) => [s.folderAddSub, pressed && s.pressed]}
            >
              <Icon name="plus" size={22} color={colors.accent} />
              <Text style={s.folderAddSubText}>Add subfolder</Text>
            </Pressable>
            {pathParts.length > 0 ? (
              <Text style={s.folderPathPreview}>
                <Text style={{ color: colors.muted }}>Will create </Text>
                {pathParts.map((part, index) => (
                  <Text key={pathParts.slice(0, index + 1).join('/')}>
                    <Text
                      style={
                        index === pathParts.length - 1 ? s.folderPathLast : { color: colors.ink }
                      }
                    >
                      {part}
                    </Text>
                    {index < pathParts.length - 1 ? (
                      <Text style={{ color: colors.muted }}>{'  ›  '}</Text>
                    ) : null}
                  </Text>
                ))}
              </Text>
            ) : null}
            {failure ? (
              <View style={s.sheetError}>
                <ErrorBanner message={failure} onDismiss={() => setFailure(null)} />
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={actionLabel}
              disabled={!canCreate}
              onPress={() => void createFolders()}
              style={({ pressed }) => [
                s.moveButton,
                pressed && s.pressed,
                !canCreate && s.moveButtonDisabled,
              ]}
            >
              <Text style={[s.moveButtonText, !canCreate && s.moveButtonTextDisabled]}>
                {busy ? 'Creating…' : actionLabel}
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </BottomSheet>
  )
}

function SortSheet({
  sort,
  onChange,
  onClose,
}: {
  sort: NoteSort
  onChange: (sort: NoteSort) => void
  onClose: () => void
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const dismiss = useRef<(after?: () => void) => void>(() => {})
  return (
    <BottomSheet title="Sort notes" onClose={onClose} dismissRef={dismiss} cardHeight={300}>
      <View accessibilityRole="radiogroup" style={s.sortCards}>
        {noteSorts.map((option) => {
          const active = sort === option.ascValue || sort === option.descValue
          const ascending = active
            ? sort === option.ascValue
            : option.defaultValue === option.ascValue
          const direction = ascending ? option.ascending : option.descending
          return (
            <Pressable
              key={option.key}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              accessibilityLabel={`${option.label}, ${direction}`}
              onPress={() => {
                if (!active) onChange(option.defaultValue)
                else onChange(ascending ? option.descValue : option.ascValue)
              }}
              style={({ pressed }) => [
                s.sortCard,
                active && s.sortCardActive,
                pressed && s.pressed,
              ]}
            >
              <View style={s.sortCardTitleRow}>
                <Text style={[s.sortCardTitle, active && s.sortCardTitleActive]}>
                  {option.label}
                </Text>
                {active ? (
                  <SwapIcon
                    from="arrowDown"
                    to="arrowUp"
                    active={sort !== option.defaultValue}
                    size={20}
                    color={colors.onAccent}
                  />
                ) : null}
              </View>
              <Text style={[s.sortCardDirection, active && s.sortCardDirectionActive]}>
                {direction}
              </Text>
            </Pressable>
          )
        })}
      </View>
      <View style={s.sortHint}>
        <Icon name="arrowUpDown" size={18} color={colors.muted} />
        <Text style={s.sortHintText}>Tap the selected one again to reverse the order.</Text>
      </View>
    </BottomSheet>
  )
}

function AboutSheet({ onClose }: { onClose: () => void }) {
  const s = useStyles()
  const { colors } = useTheme()
  const open = (url: string) => {
    void Linking.openURL(url).catch(() => {})
  }
  const shortCommit = appCommit ? appCommit.slice(0, 7) : null
  return (
    <BottomSheet title="About Typo" onClose={onClose}>
      <View style={s.sheetRow}>
        <Icon name="info" size={20} color={colors.muted} />
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
        <Icon name="commit" size={20} color={colors.muted} />
        <View style={s.sheetRowText}>
          <Text style={s.sheetRowTitle}>Commit</Text>
          <Text numberOfLines={1} style={s.sheetRowPath}>
            {shortCommit ?? 'Development build'}
          </Text>
        </View>
        {shortCommit ? <Icon name="external" size={16} color={colors.muted} /> : null}
      </Pressable>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Report an issue. Opens in your browser"
        onPress={() => open(issuesUrl)}
        style={({ pressed }) => [s.sheetRow, pressed && s.rowPressed]}
      >
        <Icon name="bug" size={20} color={colors.muted} />
        <View style={s.sheetRowText}>
          <Text style={s.sheetRowTitle}>Report an issue</Text>
          <Text numberOfLines={1} style={s.sheetRowPath}>
            {issuesUrl.replace('https://', '')}
          </Text>
        </View>
        <Icon name="external" size={16} color={colors.muted} />
      </Pressable>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Source code. Opens in your browser"
        onPress={() => open(repositoryUrl)}
        style={({ pressed }) => [s.sheetRow, pressed && s.rowPressed]}
      >
        <Icon name="code" size={20} color={colors.muted} />
        <View style={s.sheetRowText}>
          <Text style={s.sheetRowTitle}>Source</Text>
          <Text numberOfLines={1} style={s.sheetRowPath}>
            {repositoryUrl.replace('https://', '')}
          </Text>
        </View>
        <Icon name="external" size={16} color={colors.muted} />
      </Pressable>
    </BottomSheet>
  )
}

function NoteDetail({
  workspace,
  active,
  instantIn,
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
  instantIn: boolean
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
  const [findArea, setFindArea] = useState(0)
  const findProgress = useSharedValue(findOpen ? 1 : 0)
  const findTrackStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -findProgress.value * findArea }],
  }))
  useEffect(() => {
    findProgress.value = timing(findOpen ? 1 : 0, { duration: 220 })
    if (!findOpen || !focusFind) return
    const timer = setTimeout(() => findInput.current?.focus(), 80)
    return () => clearTimeout(timer)
  }, [findOpen, findProgress, focusFind])
  const [matchIndex, setMatchIndex] = useState(0)
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>()
  const [sharing, setSharing] = useState(false)
  const [openingPdf, setOpeningPdf] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const shareEpoch = useRef(0)
  const alive = useRef(true)
  const editor = useRef<SourceEditorHandle>(null)
  const pendingSave = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writing = useRef<Promise<string | null> | null>(null)
  const closing = useRef(false)
  const dismiss = useRef<(after?: () => void) => void>(() => {})
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
  async function openNativePdf() {
    if (!active || opening || openingPdf || sharing) return
    const epoch = ++shareEpoch.current
    const current = () => alive.current && shareEpoch.current === epoch
    setOpeningPdf(true)
    setError(null)
    try {
      const preview = await autoPdf.current()
      if (!current()) return
      const uri = await preparePdf({ ...savedNote, pdfUri: preview.uri })
      if (!current()) return
      if (Platform.OS === 'android') {
        const content = await FileSystem.getContentUriAsync(uri)
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
          data: content,
          type: 'application/pdf',
          flags: 1,
        })
      } else {
        if (!(await Sharing.isAvailableAsync()))
          throw new Error('Opening PDFs is not available on this device.')
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: savedNote.title,
          UTI: 'com.adobe.pdf',
        })
      }
    } catch (cause) {
      if (current()) setError(errorText(cause))
    } finally {
      if (current()) setOpeningPdf(false)
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
  }

  // Back leaves editing before it leaves the note, so compile errors come back
  // instead of the note closing.
  function leave(fromEditor = editing) {
    if (!fromEditor && !Keyboard.isVisible()) {
      dismiss.current()
      return
    }
    editor.current?.blur()
    Keyboard.dismiss()
  }

  // Show whatever PDF already exists instead of waiting for the next compile.
  const pdfUri = autoPdf.preview?.uri ?? null
  const compileError = autoPdf.error
  const issues = autoPdf.diagnostics
  // Only the open note can be underlined. Issues from imports still show their
  // file in the popup, so pass them through with their path.
  const editorIssues = useMemo(
    () =>
      issues.map((issue) =>
        issue.path === savedNote.path
          ? {
              line: issue.line,
              column: issue.column,
              severity: issue.severity,
              message: issue.message,
            }
          : {
              line: issue.line,
              column: issue.column,
              severity: issue.severity,
              message: issue.message,
              path: issue.path,
            }
      ),
    [issues, savedNote.path]
  )
  const revealIndex = Math.max(
    0,
    issues.findIndex((issue) => issue.severity === 'error')
  )
  const firstIssue = issues[revealIndex]
  const failureHint = firstIssue
    ? firstIssue.path === savedNote.path
      ? 'Check the source for the error.'
      : `The error is in ${firstIssue.path}, line ${firstIssue.line}.`
    : compileError
  // In PDF mode the viewer also mounts before the first compile, so it can show the spinner
  // and have its webview booted by the time the PDF is ready.
  const showPdf = !pdfError && (!!autoPdf.preview || (mode === 'pdf' && !autoPdf.error))

  return (
    <Screen
      onClose={close}
      onRequestClose={() => leave()}
      onDismissStart={() => {
        shareEpoch.current++
        setSharing(false)
        void flushSave()
      }}
      visible={active}
      instantIn={instantIn}
      swipeBack
      dismissOnSwipe={!editing}
      dismissRef={dismiss}
    >
      <View style={s.screen}>
        {/* Android does not resize the window for the keyboard, so pad on both
            platforms. The offset is this screen's top safe-area padding. */}
        <KeyboardAvoidingView
          style={s.flex}
          enabled={active}
          behavior={keyboardBehavior}
          keyboardVerticalOffset={top}
        >
          <View style={s.detailToolbar}>
            <IconButton name="close" label="Close note" onPress={() => dismiss.current()} />
            <View style={s.toolbarTitle}>
              <Text numberOfLines={1} style={s.toolbarHeading}>
                {savedNote.title}
              </Text>
              <Text numberOfLines={1} style={s.notePath}>
                {savedNote.path}
              </Text>
            </View>
            <IconButton
              name="share"
              label={mode === 'source' ? 'Share Typst source' : 'Share PDF'}
              onPress={() => void share()}
              disabled={opening || sharing || (mode === 'pdf' && (!!autoPdf.error || !!pdfError))}
            />
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
                issues={editorIssues}
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
                onBack={leave}
              />
            </View>
            <View
              style={[StyleSheet.absoluteFill, { opacity: mode === 'pdf' ? 1 : 0 }]}
              pointerEvents={mode === 'pdf' ? 'auto' : 'none'}
              accessibilityElementsHidden={mode !== 'pdf'}
              importantForAccessibility={mode === 'pdf' ? 'auto' : 'no-hide-descendants'}
            >
              {pdfError && (
                <View style={s.errorInset}>
                  <ErrorBanner title="PDF viewer failed" message={pdfError} />
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
              {compileError && !pdfError ? (
                <View
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  style={s.pdfFailure}
                >
                  <Icon name="alert" size={30} color={colors.coral} />
                  <Text style={s.pdfFailureTitle}>PDF compilation failed</Text>
                  <Text numberOfLines={8} style={s.pdfFailureText}>
                    {failureHint}
                  </Text>
                  {issues.length > 0 && (
                    <Action
                      label="Check source"
                      onPress={() => {
                        switchMode('source')
                        // Let the source view become visible before revealing the error.
                        setTimeout(() => editor.current?.revealIssue(revealIndex), 50)
                      }}
                    />
                  )}
                </View>
              ) : null}
            </View>
            <View pointerEvents="none" style={s.noteContentFade}>
              <Fade id="note-content-fade" color={colors.paper} mid={0.15} />
            </View>
          </View>
          <View style={s.noteDockShell}>
            <View style={s.noteDock}>
              <View
                style={s.noteFindArea}
                onLayout={(event) => setFindArea(event.nativeEvent.layout.width)}
              >
                <Reanimated.View style={[s.noteFindTrack, findTrackStyle]}>
                  <View
                    style={[s.noteFindPanel, { width: findArea || '100%' }]}
                    pointerEvents={findOpen ? 'none' : 'auto'}
                  >
                    <View style={s.noteSegments}>
                      <Pressable
                        accessibilityRole="tab"
                        accessibilityState={{ selected: mode === 'source' }}
                        onPress={() => switchMode('source')}
                        style={[s.noteSegment, mode === 'source' && s.noteSegmentActive]}
                      >
                        <Text
                          style={[s.noteSegmentText, mode === 'source' && s.noteSegmentTextActive]}
                        >
                          Source
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="tab"
                        accessibilityState={{ selected: mode === 'pdf' }}
                        onPress={() => switchMode('pdf')}
                        style={[s.noteSegment, mode === 'pdf' && s.noteSegmentActive]}
                      >
                        <Text
                          style={[s.noteSegmentText, mode === 'pdf' && s.noteSegmentTextActive]}
                        >
                          PDF
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                  <View
                    style={[s.noteFindPanel, { width: findArea || '100%' }]}
                    pointerEvents={findOpen ? 'auto' : 'none'}
                  >
                    <View style={s.findDock}>
                      <Icon name="search" size={20} color={colors.accent} />
                      <TextInput
                        ref={findInput}
                        accessibilityLabel="Find in source"
                        autoFocus={focusFind}
                        selectTextOnFocus
                        placeholder="Find in this note"
                        placeholderTextColor={colors.muted}
                        value={find}
                        onChangeText={changeFind}
                        style={s.findDockInput}
                        autoCorrect={false}
                        autoCapitalize="none"
                        returnKeyType="search"
                        onSubmitEditing={() => moveMatch(1)}
                      />
                      <Text accessibilityLiveRegion="polite" style={s.findDockCount}>
                        {matches.length
                          ? `${Math.min(matchIndex + 1, matches.length)}/${matches.length}`
                          : '0/0'}
                      </Text>
                      <IconButton
                        name="chevronUp"
                        label="Previous match"
                        onPress={() => moveMatch(-1)}
                        disabled={!matches.length}
                      />
                      <IconButton
                        name="chevronDown"
                        label="Next match"
                        onPress={() => moveMatch(1)}
                        disabled={!matches.length}
                      />
                    </View>
                  </View>
                </Reanimated.View>
              </View>
              {mode === 'source' ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={findOpen ? 'Close find' : 'Find in note'}
                  onPress={() => {
                    if (findOpen) {
                      setFindOpen(false)
                      setFocusFind(false)
                      Keyboard.dismiss()
                      editor.current?.blur()
                    } else {
                      editor.current?.blur()
                      setFocusFind(true)
                      setFindOpen(true)
                    }
                  }}
                  style={({ pressed }) => [s.noteDockButton, pressed && s.pressed]}
                >
                  <Icon name={findOpen ? 'close' : 'search'} size={24} color={colors.ink} />
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open PDF in the device viewer"
                  disabled={openingPdf || !!autoPdf.error || !!pdfError}
                  onPress={() => void openNativePdf()}
                  style={({ pressed }) => [
                    s.noteDockButton,
                    pressed && s.pressed,
                    (openingPdf || !!autoPdf.error || !!pdfError) && s.disabled,
                  ]}
                >
                  <Icon name="maximize" size={28} color={colors.ink} />
                </Pressable>
              )}
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
  onDismissed,
  onFolderCreated,
  onEditTemplate,
  obscured = false,
}: {
  vault: Vault
  folders: string[]
  directory: string
  initialTemplate?: string
  onClose: () => void
  onCreated: (note: Note) => void
  onDismissed: () => void
  onFolderCreated: (folder: NoteFolder) => void
  onEditTemplate: (source: string, onSaved: (source: string) => void) => void
  obscured?: boolean
}) {
  const s = useStyles()
  const { colors } = useTheme()
  const { top } = useSafeAreaInsets()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const bodyRef = useRef<React.ComponentRef<typeof TextInput>>(null)
  const [destination, setDestination] = useState(directory)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [template, setTemplate] = useState<string | null>(initialTemplate ?? null)
  const [templateLoading, setTemplateLoading] = useState(initialTemplate === undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const alive = useRef(true)
  const dismiss = useRef<(after?: () => void) => void>(() => {})
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
    else dismiss.current()
  }
  async function create() {
    if (!title.trim() || saving || template === null) return
    setSaving(true)
    setError(null)
    try {
      const note = await createNote(vault, title.trim(), body, destination, template)
      if (!alive.current) return
      // Put the note in place behind the sheet, then let the sheet slide away
      // over it instead of over the library.
      onCreated(note)
      requestAnimationFrame(() => {
        if (!alive.current) return
        dismiss.current(() => {
          if (alive.current) onDismissed()
        })
      })
    } catch (cause) {
      if (alive.current) {
        setError(errorText(cause))
        setSaving(false)
      }
    }
  }
  return (
    <>
      <Screen onClose={onClose} onRequestClose={close} edge="bottom" dismissRef={dismiss}>
        <View
          style={s.screen}
          accessibilityElementsHidden={pickingFolder || obscured}
          importantForAccessibility={pickingFolder || obscured ? 'no-hide-descendants' : 'auto'}
        >
          {/* Android does not resize the window for the keyboard, so pad on both
              platforms. The offset is this screen's top safe-area padding. */}
          <KeyboardAvoidingView
            style={s.flex}
            importantForAccessibility={confirming ? 'no-hide-descendants' : 'auto'}
            behavior={keyboardBehavior}
            keyboardVerticalOffset={top}
          >
            <View style={s.newToolbar}>
              <IconButton name="close" label="Close new note" onPress={close} disabled={saving} />
              <Text style={[s.newHeading, s.flex]}>New note</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create note"
                disabled={!title.trim() || saving || templateLoading || template === null}
                onPress={() => void create()}
                style={({ pressed }) => [
                  s.newCreate,
                  pressed && s.pressed,
                  (!title.trim() || saving || templateLoading || template === null) &&
                    s.newCreateDisabled,
                ]}
              >
                <Text
                  style={[
                    s.newCreateText,
                    (!title.trim() || saving || templateLoading || template === null) &&
                      s.newCreateTextDisabled,
                  ]}
                >
                  {saving ? 'Creating…' : 'Create'}
                </Text>
              </Pressable>
            </View>
            <ScrollView
              style={s.flex}
              contentContainerStyle={s.newForm}
              keyboardShouldPersistTaps="handled"
            >
              <View style={s.newMeta}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Create in ${destination || vault.name}. Choose folder`}
                  disabled={saving}
                  onPress={() => {
                    Keyboard.dismiss()
                    setPickingFolder(true)
                  }}
                  style={({ pressed }) => [
                    s.newFolderPill,
                    pressed && s.pressed,
                    saving && s.disabled,
                  ]}
                >
                  <Icon name="folderOpen" size={18} color={colors.muted} />
                  <Text numberOfLines={1} style={s.newFolderText}>
                    {destination ? folderName(destination) : vault.name}
                  </Text>
                  <Icon name="chevronDown" size={18} color={colors.muted} />
                </Pressable>
                <View style={s.flex} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Edit note template"
                  disabled={saving || templateLoading || template === null}
                  onPress={() => {
                    Keyboard.dismiss()
                    if (template !== null) onEditTemplate(template, (source) => setTemplate(source))
                  }}
                  style={({ pressed }) => [
                    s.newTemplate,
                    pressed && s.pressed,
                    (saving || templateLoading || template === null) && s.disabled,
                  ]}
                >
                  <Text style={s.newTemplateText}>template.typ</Text>
                  <View style={s.newTemplateEdit}>
                    <Icon name="edit" size={16} color={colors.accent} />
                    <Text style={s.newTemplateEditText}>Edit</Text>
                  </View>
                </Pressable>
              </View>
              {error && (
                <View style={s.errorInset}>
                  <ErrorBanner message={error} onDismiss={() => setError(null)} />
                </View>
              )}
              <View style={s.newTitleBlock}>
                <TextInput
                  accessibilityLabel="Note title"
                  placeholder="Give it a title"
                  placeholderTextColor={colors.muted}
                  value={title}
                  onChangeText={setTitle}
                  editable={!saving}
                  maxLength={180}
                  style={s.newTitle}
                  cursorColor={colors.accent}
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => bodyRef.current?.focus()}
                />
                <View style={s.newDivider} />
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
                  cursorColor={colors.accent}
                  style={s.newBody}
                />
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
          <ConfirmDialog
            visible={confirming}
            title="Leave unsaved changes?"
            message="Your changes haven’t been saved to the notes folder."
            confirmLabel="Discard changes"
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false)
              dismiss.current()
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
          mode="create-in"
          confirmLabel="Use folder"
          onConfirm={async (path) => {
            setDestination(path)
            setPickingFolder(false)
          }}
          onFolderCreated={onFolderCreated}
          onClose={() => setPickingFolder(false)}
        />
      )}
    </>
  )
}

type TemplateProblem = {
  name: string
  from: number
  to: number
  line: number
  column: number
}

function templateProblems(source: string): TemplateProblem[] {
  const problems: TemplateProblem[] = []
  for (const match of source.matchAll(/\{\{([^{}]*)\}\}/gu)) {
    const name = match[1].trim()
    if (name === 'title' || name === 'body') continue
    const from = match.index ?? 0
    const lineStart = source.lastIndexOf('\n', Math.max(0, from - 1)) + 1
    const inside = source.slice(from + 2, from + match[0].length - 2)
    const leading = inside.length - inside.trimStart().length
    problems.push({
      name,
      from,
      to: from + match[0].length,
      line: source.slice(0, from).split('\n').length,
      column: from - lineStart + 3 + leading,
    })
  }
  return problems
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
  const { colors } = useTheme()
  const { top } = useSafeAreaInsets()
  const [current, setCurrent] = useState(source)
  const saved = source
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [editorHeight, setEditorHeight] = useState(0)
  const [cardHeight, setCardHeight] = useState(0)
  const editor = useRef<SourceEditorHandle>(null)
  const alive = useRef(true)
  const dismiss = useRef<(after?: () => void) => void>(() => {})
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const dirty = current !== saved
  const problems = useMemo(() => templateProblems(current), [current])
  const issues = useMemo(
    () =>
      problems.map((problem) => ({
        line: problem.line,
        column: problem.column,
        severity: 'error' as const,
        message: `Unknown placeholder {{${problem.name}}}.`,
      })),
    [problems]
  )
  const first = problems[0]
  const card = selected === null ? undefined : problems[selected]
  const wantedTop = card
    ? TEMPLATE_CONTENT_TOP +
      (card.line - 1) * TEMPLATE_LINE_HEIGHT +
      TEMPLATE_LINE_HEIGHT +
      (card.line > 4 ? TEMPLATE_LINE_HEIGHT : 0)
    : 0
  const errorTop = card ? Math.min(wantedTop, Math.max(8, editorHeight - cardHeight - 8)) : 0
  const close = () => {
    if (saving) return
    if (confirming) {
      setConfirming(false)
      return
    }
    // Keep the keyboard up while the confirm sheet is open. Dismissing it here
    // makes the editor resize for a frame and flicker before the dialog lands.
    if (dirty) {
      setConfirming(true)
      return
    }
    Keyboard.dismiss()
    dismiss.current()
  }
  async function save(value = current) {
    if (saving || problems.length > 0) return
    setSaving(true)
    setError(null)
    try {
      await saveTemplate(vault, value, saved)
      if (alive.current) dismiss.current(() => onSaved(value))
    } catch (cause) {
      if (alive.current) {
        setError(errorText(cause))
        setSaving(false)
      }
    }
  }
  function applyPlaceholder(name: 'title' | 'body') {
    if (!card) return
    const next = `${current.slice(0, card.from)}{{${name}}}${current.slice(card.to)}`
    setCurrent(next)
    setSelected(null)
    setError(null)
  }
  const subtitle = first
    ? `${problems.length} problem${problems.length === 1 ? '' : 's'}`
    : 'template.typ'
  return (
    <Screen onClose={onClose} onRequestClose={close} insets={false} dismissRef={dismiss}>
      <View style={s.screen}>
        <KeyboardAvoidingView
          style={s.flex}
          importantForAccessibility={confirming ? 'no-hide-descendants' : 'auto'}
          behavior={keyboardBehavior}
          keyboardVerticalOffset={top}
        >
          <View style={[s.templateToolbar, { paddingTop: top + 14 }]}>
            <IconButton
              name="close"
              label="Close template editor"
              onPress={close}
              disabled={saving}
            />
            <View style={s.templateTitleBlock}>
              <Text style={s.templateTitle}>Template</Text>
              <View style={s.templateSubtitleRow}>
                {first && <View style={[s.templateDot, { backgroundColor: colors.coral }]} />}
                <Text
                  numberOfLines={1}
                  style={[s.templateSubtitle, first && s.templateSubtitleError]}
                >
                  {subtitle}
                </Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save template"
              disabled={saving || !dirty || problems.length > 0}
              onPress={() => void save()}
              style={({ pressed }) => [
                s.templateSave,
                pressed && s.pressed,
                (saving || !dirty || problems.length > 0) && s.templateSaveDisabled,
              ]}
            >
              <Text
                style={[
                  s.templateSaveText,
                  (saving || !dirty || problems.length > 0) && s.templateSaveTextDisabled,
                ]}
              >
                {saving ? 'Saving…' : 'Save'}
              </Text>
            </Pressable>
          </View>
          <Text style={s.templateIntro}>
            New notes start from this file. <Text style={s.templatePlaceholder}>{'{{title}}'}</Text>{' '}
            and <Text style={s.templatePlaceholder}>{'{{body}}'}</Text> are filled in when you
            create a note.
          </Text>
          {error && (
            <View style={s.errorInset}>
              <ErrorBanner message={error} onDismiss={() => setError(null)} />
            </View>
          )}
          <View
            style={s.flex}
            onLayout={(event) => setEditorHeight(event.nativeEvent.layout.height)}
          >
            <SourceEditor
              ref={editor}
              documentId="template"
              value={current}
              issues={issues}
              template
              onChangeText={(text) => {
                setCurrent(text)
                setSelected(null)
              }}
              onIssuePress={(index) => setSelected(index < 0 ? null : index)}
              editable={!saving}
              waitForKeyboardHide={false}
              onPainted={() => {}}
              onFocusChange={() => {}}
              onError={(message) => setError(message)}
              onSave={(value) => void save(value)}
              onBack={close}
            />
            {card ? (
              <View
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                onLayout={(event) => setCardHeight(event.nativeEvent.layout.height)}
                style={[s.templateErrorCard, { top: errorTop }]}
              >
                <View style={s.templateErrorHeader}>
                  <Icon name="alert" size={20} color={colors.coral} />
                  <Text style={s.templateErrorText}>
                    Unknown placeholder {`{{${card.name}}}`}. Only {'{{title}}'} and {'{{body}}'}{' '}
                    work here.
                  </Text>
                </View>
                <View style={s.templateErrorActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => applyPlaceholder('title')}
                    style={({ pressed }) => [s.templateErrorButton, pressed && s.pressed]}
                  >
                    <Text style={s.templateErrorButtonText}>{'Use {{title}}'}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => applyPlaceholder('body')}
                    style={({ pressed }) => [s.templateErrorButton, pressed && s.pressed]}
                  >
                    <Text style={s.templateErrorButtonText}>{'Use {{body}}'}</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>
          <View style={s.templateFooter}>
            <View style={s.templatePills}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Insert title placeholder"
                disabled={saving}
                onPress={() => editor.current?.insert('{{title}}')}
                style={({ pressed }) => [s.templatePill, pressed && s.pressed]}
              >
                <Icon name="plus" size={22} color={colors.accent} />
                <Text style={s.templatePillText}>{'{{title}}'}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Insert body placeholder"
                disabled={saving}
                onPress={() => editor.current?.insert('{{body}}')}
                style={({ pressed }) => [s.templatePill, pressed && s.pressed]}
              >
                <Icon name="plus" size={22} color={colors.accent} />
                <Text style={s.templatePillText}>{'{{body}}'}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
        <ConfirmDialog
          visible={confirming}
          local
          title="Discard template changes?"
          message="Your template changes haven’t been saved."
          confirmLabel="Discard changes"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            Keyboard.dismiss()
            dismiss.current()
          }}
        />
      </View>
    </Screen>
  )
}

function AppearanceSettings({ onClose }: { onClose: () => void }) {
  const s = useStyles()
  const { settings, updateSettings, palette, colors, persistenceError } = useTheme()
  const [customOpen, setCustomOpen] = useState(false)
  const dismiss = useRef<(after?: () => void) => void>(() => {})
  const custom = settings.customAccent
  const accentLabel = custom
    ? 'Custom'
    : settings.accent.charAt(0).toUpperCase() + settings.accent.slice(1)
  return (
    <>
      <Screen onClose={onClose} swipeBack dismissRef={dismiss}>
        <View style={s.screen}>
          <View style={s.appearanceToolbar}>
            <IconButton
              name="close"
              label="Close appearance settings"
              onPress={() => dismiss.current()}
            />
            <Text style={s.appearanceTitle}>Appearance</Text>
          </View>
          <ScrollView contentContainerStyle={s.appearanceBody}>
            <View style={s.settingsSection}>
              <Text style={s.settingsLabel}>MODE</Text>
              <View style={s.modeRow}>
                {(['system', 'light', 'dark'] as AppearanceMode[]).map((option) => {
                  const active = settings.mode === option
                  return (
                    <Pressable
                      key={option}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: active }}
                      onPress={() => updateSettings({ mode: option })}
                      style={[s.modeButton, active && s.modeButtonActive]}
                    >
                      <Text style={[s.modeText, active && s.modeTextActive]}>
                        {option.charAt(0).toUpperCase() + option.slice(1)}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
              <Text style={s.settingsLabel}>PALETTE</Text>
              <View style={s.flavorRow}>
                <View accessibilityRole="radiogroup" style={s.flavorLight}>
                  <Text style={s.flavorGroupLabel}>LIGHT</Text>
                  <FlavorOption
                    flavor={lightFlavorNames[0]}
                    selected={settings.lightFlavor === lightFlavorNames[0]}
                    onPress={() => updateSettings({ lightFlavor: lightFlavorNames[0] })}
                  />
                </View>
                <View style={s.flavorDivider} />
                <View style={s.flex}>
                  <Text style={s.flavorGroupLabel}>DARK</Text>
                  <View accessibilityRole="radiogroup" style={s.flavorDarkRow}>
                    {darkFlavorNames.map((flavor) => (
                      <FlavorOption
                        key={flavor}
                        flavor={flavor}
                        selected={settings.darkFlavor === flavor}
                        onPress={() => updateSettings({ darkFlavor: flavor })}
                      />
                    ))}
                  </View>
                </View>
              </View>
              <View style={s.accentLabelRow}>
                <Text style={s.settingsLabel}>ACCENT</Text>
                <Text style={s.accentValue}>{accentLabel}</Text>
              </View>
              <View accessibilityRole="radiogroup" style={s.accentGrid}>
                {accentNames.map((accent) => {
                  const swatch = palette[accent]
                  const selected = !custom && settings.accent === accent
                  return (
                    <Pressable
                      key={accent}
                      accessibilityRole="radio"
                      accessibilityLabel={accent}
                      accessibilityState={{ checked: selected }}
                      onPress={() => updateSettings({ accent, customAccent: null })}
                      style={s.accentPressable}
                    >
                      <View style={[s.accentSwatch, { backgroundColor: swatch }]}>
                        {selected && (
                          <>
                            <View style={s.selectedRing} />
                            <Icon
                              name="check"
                              size={18}
                              color={luminance(swatch) > 0.179 ? '#000000' : '#ffffff'}
                            />
                          </>
                        )}
                      </View>
                    </Pressable>
                  )
                })}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={custom ? 'Edit custom color' : 'Choose a custom color'}
                onPress={() => setCustomOpen(true)}
                style={({ pressed }) => [s.customRow, pressed && s.pressed]}
              >
                <View
                  style={[
                    s.customCircle,
                    custom && { backgroundColor: custom, borderColor: custom },
                  ]}
                >
                  {custom ? (
                    <Icon
                      name="check"
                      size={18}
                      color={luminance(custom) > 0.179 ? '#000000' : '#ffffff'}
                    />
                  ) : (
                    <Icon name="plus" size={16} color={colors.muted} />
                  )}
                  {custom ? <View style={s.selectedRing} /> : null}
                </View>
                <View style={s.flex}>
                  <Text style={s.customTitle}>Custom color</Text>
                  {custom ? <Text style={s.customHex}>{custom}</Text> : null}
                </View>
                {custom ? (
                  <View style={s.customEdit}>
                    <Icon name="edit" size={16} color={colors.accent} />
                    <Text style={s.customEditText}>Edit</Text>
                  </View>
                ) : null}
              </Pressable>
              <Pressable
                accessibilityRole="switch"
                accessibilityLabel="AMOLED black. Use pure black in dark mode."
                accessibilityState={{ checked: settings.amoled }}
                onPress={() => updateSettings({ amoled: !settings.amoled })}
                style={({ pressed }) => [s.amoledRow, pressed && s.pressed]}
              >
                <View style={s.flex}>
                  <Text style={s.amoledTitle}>AMOLED black</Text>
                  <Text style={s.amoledBody}>Pure black in dark mode.</Text>
                </View>
                <View
                  style={[s.toggleTrack, settings.amoled && { backgroundColor: colors.accent }]}
                >
                  <View
                    style={[
                      s.toggleThumb,
                      settings.amoled && s.toggleThumbOn,
                      settings.amoled && { backgroundColor: colors.onAccent },
                    ]}
                  />
                </View>
              </Pressable>
              {persistenceError && <Text style={s.errorText}>{persistenceError}</Text>}
            </View>
          </ScrollView>
        </View>
      </Screen>
      {customOpen && (
        <CustomColorSheet
          initial={custom ?? colors.accent}
          onClose={() => setCustomOpen(false)}
          onPick={(hex) => {
            updateSettings({ customAccent: hex })
            setCustomOpen(false)
          }}
        />
      )}
    </>
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
  const { settings, colors } = useTheme()
  const preview = palettes[flavor]
  const dot = selected ? colors.accent : preview[settings.accent]
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${flavor} palette`}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [s.flavorCard, pressed && s.pressed]}
    >
      <View
        style={[
          s.flavorPreview,
          { backgroundColor: preview.base },
          selected && { borderColor: colors.accent },
        ]}
      >
        <View style={[s.flavorDot, { backgroundColor: dot }]} />
        <View style={[s.flavorBar, { backgroundColor: preview.text }]} />
      </View>
      <Text style={[s.flavorText, selected && s.flavorTextSelected]}>
        {flavor === 'frappe' ? 'Frappé' : flavor.charAt(0).toUpperCase() + flavor.slice(1)}
      </Text>
    </Pressable>
  )
}

function ColorSlider({
  value,
  onChange,
  renderTrack,
  label,
  valueLabel,
  knobColor,
}: {
  value: number
  onChange: (value: number) => void
  renderTrack: () => React.ReactNode
  label: string
  valueLabel: string
  knobColor: string
}) {
  const s = useStyles()
  const width = useRef(0)
  const widthValue = useSharedValue(0)
  const position = useSharedValue(value)
  const dragging = useSharedValue(false)
  const last = useRef(0)
  const change = useRef(onChange)
  change.current = onChange
  const commit = useCallback((x: number) => {
    if (width.current <= 0) return
    change.current(Math.min(1, Math.max(0, x / width.current)))
  }, [])
  // The knob follows the finger on the UI thread. Rebuilding the gradient and
  // the hex field on every move re-renders the sheet, so those wait for the
  // throttle and the release.
  const commitThrottled = useCallback(
    (x: number) => {
      const now = Date.now()
      if (now - last.current < 40) return
      last.current = now
      commit(x)
    },
    [commit]
  )
  useEffect(() => {
    if (!dragging.value) position.value = value
  }, [dragging, position, value])
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .hitSlop({ top: 14, bottom: 14, left: 8, right: 8 })
        .onBegin((event) => {
          'worklet'
          dragging.value = true
          position.value = Math.min(1, Math.max(0, event.x / Math.max(widthValue.value, 1)))
          runOnJS(commit)(event.x)
        })
        .onUpdate((event) => {
          'worklet'
          position.value = Math.min(1, Math.max(0, event.x / Math.max(widthValue.value, 1)))
          runOnJS(commitThrottled)(event.x)
        })
        .onEnd((event) => {
          'worklet'
          runOnJS(commit)(event.x)
        })
        .onFinalize(() => {
          'worklet'
          dragging.value = false
        }),
    [commit, commitThrottled, dragging, position, widthValue]
  )
  const knob = useAnimatedStyle(() => ({ left: `${position.value * 100}%` }))
  return (
    <View style={s.sliderSection}>
      <View style={s.sliderLabelRow}>
        <Text style={s.sliderLabel}>{label}</Text>
        <Text style={s.sliderValue}>{valueLabel}</Text>
      </View>
      <GestureDetector gesture={pan}>
        <View
          style={s.sliderTrack}
          onLayout={(event) => {
            width.current = event.nativeEvent.layout.width
            widthValue.value = event.nativeEvent.layout.width
          }}
        >
          {renderTrack()}
          <Reanimated.View
            pointerEvents="none"
            style={[s.sliderKnob, knob, { backgroundColor: knobColor }]}
          />
        </View>
      </GestureDetector>
    </View>
  )
}

function CustomColorSheet({
  initial,
  onClose,
  onPick,
}: {
  initial: string
  onClose: () => void
  onPick: (hex: string) => void
}) {
  const s = useStyles()
  const { colors, palette } = useTheme()
  const start = parseHex(initial) ?? '#CBA6F7'
  const startHsl = hexToHsl(start)
  const [hue, setHue] = useState(startHsl.h)
  const [lightness, setLightness] = useState(startHsl.l)
  const [saturation, setSaturation] = useState(startHsl.s)
  const [hex, setHex] = useState(start)
  const [text, setText] = useState(start.slice(1))
  const applyHex = (value: string) => {
    const parsed = parseHex(`#${value}`)
    if (!parsed) return
    const hsl = hexToHsl(parsed)
    setHue(hsl.h)
    setLightness(hsl.l)
    setSaturation(hsl.s)
    setHex(parsed)
  }
  const applyHsl = (nextHue: number, nextLightness: number) => {
    const parsed = hslToHex({ h: nextHue, s: saturation, l: nextLightness })
    setHex(parsed)
    setText(parsed.slice(1))
  }
  const contrast = contrastRatio(hex, colors.paper)
  const readable = contrast >= 4.5
  return (
    <BottomSheet title="Custom color" onClose={onClose} cardHeight={620}>
      <ScrollView
        style={s.flex}
        contentContainerStyle={s.colorSheetBody}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.colorSection}>
          <Text style={s.colorLabel}>HEX</Text>
          <View style={[s.hexField, { borderColor: hex }]}>
            <View style={[s.hexSwatch, { backgroundColor: hex }]} />
            <Text style={s.hexHash}>#</Text>
            <TextInput
              accessibilityLabel="Custom hex color"
              value={text}
              onChangeText={(value) => {
                const next = value
                  .replace(/[^0-9a-fA-F]/gu, '')
                  .slice(0, 6)
                  .toUpperCase()
                setText(next)
                if (next.length === 6) applyHex(next)
              }}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={6}
              returnKeyType="done"
              onSubmitEditing={() => Keyboard.dismiss()}
              cursorColor={hex}
              style={s.hexInput}
            />
          </View>
        </View>
        <ColorSlider
          label="HUE"
          value={hue / 360}
          valueLabel={`${Math.round(hue)}°`}
          knobColor={hex}
          onChange={(value) => {
            const nextHue = value * 360
            setHue(nextHue)
            applyHsl(nextHue, lightness)
          }}
          renderTrack={() => (
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id="hue-track" x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0" stopColor="#ff0000" />
                  <Stop offset="0.17" stopColor="#ffff00" />
                  <Stop offset="0.33" stopColor="#00ff00" />
                  <Stop offset="0.5" stopColor="#00ffff" />
                  <Stop offset="0.67" stopColor="#0000ff" />
                  <Stop offset="0.83" stopColor="#ff00ff" />
                  <Stop offset="1" stopColor="#ff0000" />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" rx={7} fill="url(#hue-track)" />
            </Svg>
          )}
        />
        <ColorSlider
          label="LIGHTNESS"
          value={lightness}
          valueLabel={`${Math.round(lightness * 100)}%`}
          knobColor={hex}
          onChange={(value) => {
            setLightness(value)
            applyHsl(hue, value)
          }}
          renderTrack={() => (
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id="lightness-track" x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0" stopColor="#000000" />
                  <Stop offset={lightness} stopColor={hex} />
                  <Stop offset="1" stopColor="#ffffff" />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" rx={7} fill="url(#lightness-track)" />
            </Svg>
          )}
        />
        <View style={s.contrastRow}>
          <Icon
            name={readable ? 'checkCircle' : 'alert'}
            size={18}
            color={readable ? palette.green : colors.coral}
          />
          <Text style={s.contrastText}>
            {readable
              ? `Readable with a contrast of ${contrast.toFixed(1)}:1`
              : `Low contrast (${contrast.toFixed(1)}:1)`}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Use this color"
          onPress={() => onPick(hex)}
          style={({ pressed }) => [
            s.useColorButton,
            { backgroundColor: hex },
            pressed && s.pressed,
          ]}
        >
          <Text style={[s.useColorText, { color: luminance(hex) > 0.179 ? '#000000' : '#ffffff' }]}>
            Use this color
          </Text>
        </Pressable>
      </ScrollView>
    </BottomSheet>
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
      gap: 10,
      paddingTop: 18,
      paddingRight: 12,
      paddingBottom: 10,
      paddingLeft: 20,
    },
    brandLockup: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
    brand: { fontFamily: 'DMSans_600SemiBold', color: colors.ink, fontSize: 22, letterSpacing: -1 },
    folderButton: {
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 1,
      maxWidth: 180,
      gap: 8,
      height: 44,
      paddingHorizontal: 14,
      borderRadius: 14,
      backgroundColor: colors.soft,
    },
    folderName: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 15,
      color: colors.ink,
      flexShrink: 1,
    },
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
    errorInset: { paddingHorizontal: 24, paddingVertical: 8 },
    pdfFailure: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      gap: 10,
      backgroundColor: colors.paper,
      zIndex: 4,
      elevation: 4,
    },
    pdfFailureTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
      color: colors.ink,
      textAlign: 'center',
    },
    pdfFailureText: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      lineHeight: 20,
      color: colors.muted,
      textAlign: 'center',
      marginBottom: 6,
    },
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
      paddingHorizontal: 24,
      paddingBottom: 32,
    },
    onboardSpacer: {
      flexGrow: 1,
      minHeight: 260,
      alignItems: 'center',
      justifyContent: 'center',
    },
    list: { paddingTop: 4, paddingBottom: 140 },
    emptyList: { flexGrow: 1 },
    listLayer: { backgroundColor: colors.paper },
    hiddenList: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: colors.paper,
    },
    swipeShell: {
      position: 'relative',
      borderBottomColor: colors.line,
      borderBottomWidth: 1,
    },
    swipeClipped: { overflow: 'hidden' },
    swipeAction: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: SWIPE_ACTION_WIDTH,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1,
    },
    swipeTrashPane: {
      right: 0,
      backgroundColor: colors.coral,
      borderTopLeftRadius: 15,
      borderBottomLeftRadius: 15,
      alignItems: 'flex-end',
      paddingRight: 12,
    },
    swipeFavoritePane: {
      left: 0,
      backgroundColor: colors.accent,
      borderTopRightRadius: 15,
      borderBottomRightRadius: 15,
      alignItems: 'flex-start',
      paddingLeft: 12,
    },
    swipeActionContent: {
      width: SWIPE_ACTION_WIDTH - 24,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
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
    swapIconLayer: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    swapLabel: { width: '100%', height: 14, alignItems: 'center', justifyContent: 'center' },
    swapLabelLayer: {
      position: 'absolute',
      width: '100%',
      textAlign: 'center',
    },
    swipeActionLabel: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 10,
      letterSpacing: 1.4,
      color: colors.paper,
    },
    swipeForeground: { backgroundColor: colors.paper, zIndex: 2 },
    noteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      height: 71,
      paddingHorizontal: 20,
    },
    rowPressed: { backgroundColor: colors.soft },
    trashNotice: {
      position: 'absolute',
      left: 16,
      right: 16,
      bottom: 116,
      height: 68,
      borderRadius: 22,
      paddingLeft: 12,
      paddingRight: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.surface,
      borderColor: colors.surfaceHi,
      borderWidth: 1,
      zIndex: 4,
      elevation: 12,
      shadowColor: '#000000',
      shadowOpacity: 0.5,
      shadowRadius: 32,
      shadowOffset: { width: 0, height: 12 },
    },
    trashNoticeIcon: {
      width: 40,
      height: 40,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    trashNoticeTitle: { fontFamily: 'DMSans_600SemiBold', fontSize: 15, color: colors.ink },
    trashNoticeBody: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      lineHeight: 17,
      color: colors.muted,
      marginTop: 1,
    },
    noteGlyph: {
      width: 44,
      height: 44,
      borderRadius: 14,
      backgroundColor: colors.soft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    folderGlyph: {
      width: 44,
      height: 44,
      borderRadius: 14,
      backgroundColor: colors.soft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    noteInfo: { flex: 1, gap: 2, minWidth: 0 },
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
      lineHeight: 16,
      marginTop: 1,
    },
    snippet: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 15,
      lineHeight: 22,
      color: colors.subtle,
      marginTop: 6,
    },
    fab: {
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 8,
      shadowColor: '#000000',
      shadowOpacity: 0.4,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 },
    },
    fabPressed: { transform: [{ scale: 0.96 }] },
    notice: {
      position: 'absolute',
      left: 16,
      right: 16,
      bottom: 116,
      minHeight: 68,
      borderRadius: 22,
      paddingVertical: 12,
      paddingHorizontal: 12,
      paddingRight: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.surface,
      borderColor: colors.surfaceHi,
      borderWidth: 1,
      zIndex: 4,
      elevation: 12,
      shadowColor: '#000000',
      shadowOpacity: 0.5,
      shadowRadius: 32,
      shadowOffset: { width: 0, height: 12 },
    },
    noticeIcon: {
      width: 40,
      height: 40,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.soft,
    },
    noticeTitle: { fontFamily: 'DMSans_600SemiBold', fontSize: 15, color: colors.ink },
    noticeBody: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      lineHeight: 17,
      color: colors.muted,
      marginTop: 1,
    },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 40,
      paddingTop: 46,
      paddingBottom: 16,
      gap: 12,
    },
    emptyIcon: {
      width: 72,
      height: 72,
      backgroundColor: colors.soft,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emptyTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 26,
      lineHeight: 32,
      color: colors.ink,
      textAlign: 'center',
      letterSpacing: -0.6,
      marginTop: 6,
    },
    emptyBody: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 16,
      lineHeight: 24,
      color: colors.muted,
      textAlign: 'center',
      maxWidth: 280,
    },
    textLink: { padding: 12 },
    linkText: { fontFamily: 'DMSans_600SemiBold', color: colors.accent, fontSize: 16 },
    detailToolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingTop: 14,
      paddingBottom: 10,
      gap: 4,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    toolbarTitle: { flex: 1, gap: 1 },
    toolbarHeading: {
      fontFamily: 'DMSans_600SemiBold',
      color: colors.ink,
      fontSize: 18,
      lineHeight: 24,
    },
    pdf: { flex: 1, width: '100%', backgroundColor: colors.crust },
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
    newForm: { flexGrow: 1 },
    dialogOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    // No elevation here: Android draws the shadow of a full-screen elevated
    // view inside the screen, which bands the dim around the dialog.
    dialogLayer: { zIndex: 40 },
    dialogCard: {
      width: '100%',
      maxWidth: 360,
      // Raised surface: `paper` is pure black in AMOLED mode and would make the
      // card disappear into the dimmed page.
      backgroundColor: colors.white,
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
    sheetBackdrop: { backgroundColor: 'rgba(0, 0, 0, 0.6)' },
    sheetGrabber: { alignItems: 'center', marginBottom: 16 },
    sheetCard: {
      width: '100%',
      maxHeight: '86%',
      backgroundColor: colors.soft,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      paddingTop: 12,
      paddingHorizontal: 16,
    },
    sheetHandle: { width: 44, height: 5, borderRadius: 3, backgroundColor: colors.surface2 },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 4,
      paddingBottom: 12,
    },
    sheetTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 24,
      lineHeight: 30,
      letterSpacing: -0.4,
      color: colors.ink,
    },
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
    sheetParentHint: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 18,
      color: colors.muted,
      paddingHorizontal: 20,
      marginBottom: 4,
    },
    sheetError: { paddingHorizontal: 20, paddingTop: 6 },
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
    headerButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 14,
    },
    rowPath: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.muted,
      lineHeight: 18,
    },
    trashUndo: {
      height: 44,
      paddingHorizontal: 16,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    trashUndoText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 15,
      color: colors.accent,
    },
    searchList: { paddingBottom: 140 },
    searchGroup: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
      letterSpacing: 1.2,
      color: colors.muted,
      paddingTop: 20,
      paddingHorizontal: 20,
      paddingBottom: 4,
    },
    searchRow: {
      height: 102,
      paddingVertical: 14,
      paddingHorizontal: 20,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    searchTitleRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 8,
    },
    searchTitle: {
      flexShrink: 1,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 18,
      lineHeight: 24,
      letterSpacing: -0.3,
      color: colors.ink,
    },
    searchPath: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.muted,
    },
    highlight: {
      borderRadius: 4,
      paddingHorizontal: 2,
      color: colors.ink,
    },
    crumbs: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingTop: 4,
      paddingHorizontal: 20,
    },
    crumbHome: {
      width: 22,
      height: 22,
      alignItems: 'center',
      justifyContent: 'center',
    },
    crumbScroll: { alignItems: 'center', gap: 6 },
    crumbGroup: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    crumbButton: {
      maxWidth: 180,
      minHeight: 22,
      justifyContent: 'center',
      borderRadius: 8,
    },
    crumbText: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      lineHeight: 20,
      color: colors.muted,
    },
    crumbCurrent: {
      fontFamily: 'DMSans_600SemiBold',
      color: colors.ink,
    },
    emptyButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      height: 52,
      paddingHorizontal: 24,
      borderRadius: 26,
      backgroundColor: colors.accent,
      marginTop: 12,
    },
    emptyButtonText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 16,
      color: colors.onAccent,
    },
    dockShell: {
      backgroundColor: colors.paper,
    },
    listFade: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: 110,
    },
    dock: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingTop: 12,
      paddingHorizontal: 16,
      paddingBottom: 28,
    },
    searchField: {
      flex: 1,
      minWidth: 0,
      height: 60,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingLeft: 18,
      paddingRight: 14,
      borderRadius: 30,
      backgroundColor: colors.surface,
      borderWidth: 1.5,
      borderColor: colors.accent,
      elevation: 8,
      shadowColor: '#000000',
      shadowOpacity: 0.4,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 },
    },
    searchFieldActive: { borderWidth: 2 },
    searchFieldInput: {
      flex: 1,
      minWidth: 0,
      color: colors.ink,
      fontFamily: 'DMSans_400Regular',
      fontSize: 17,
      paddingVertical: 0,
      paddingHorizontal: 0,
    },
    searchFieldAction: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelSearch: {
      height: 60,
      paddingHorizontal: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelSearchText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 16,
      color: colors.accent,
    },
    onboardArt: {
      width: 190,
      height: 232,
      marginBottom: 40,
    },
    onboardPaper: {
      width: 190,
      height: 232,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.soft,
      paddingHorizontal: 20,
      paddingVertical: 24,
      transform: [{ rotate: '5deg' }],
      elevation: 12,
      shadowColor: '#000000',
      shadowOpacity: 0.45,
      shadowRadius: 40,
      shadowOffset: { width: 0, height: 20 },
    },
    onboardCode: {
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 11,
      lineHeight: 19,
      color: colors.ink,
    },
    onboardCodeIndent: { paddingLeft: 13 },
    onboardCodeGap: { height: 9 },
    onboardPen: {
      position: 'absolute',
      right: -22,
      bottom: -14,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 10,
      shadowColor: '#000000',
      shadowOpacity: 0.4,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 10 },
    },
    onboardTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 34,
      lineHeight: 38,
      letterSpacing: -0.9,
      color: colors.ink,
    },
    onboardBody: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 16,
      lineHeight: 24,
      color: colors.muted,
      marginTop: 12,
    },
    onboardButton: {
      marginTop: 28,
      width: '100%',
      height: 60,
      borderRadius: 30,
      backgroundColor: colors.accent,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
    },
    onboardButtonText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 18,
      color: colors.onAccent,
    },
    newToolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingTop: 14,
      paddingRight: 12,
      paddingBottom: 10,
      paddingLeft: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    newHeading: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 22,
      letterSpacing: -0.4,
      color: colors.ink,
    },
    newCreate: {
      height: 44,
      paddingHorizontal: 20,
      borderRadius: 22,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    newCreateText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 16,
      color: colors.onAccent,
    },
    newCreateDisabled: { backgroundColor: colors.surface },
    newCreateTextDisabled: { color: colors.muted },
    newMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 16,
      marginHorizontal: 20,
    },
    newFolderPill: {
      height: 40,
      paddingHorizontal: 14,
      borderRadius: 20,
      backgroundColor: colors.soft,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    newFolderText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 15,
      color: colors.ink,
    },
    newTemplate: {
      height: 40,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 6,
    },
    newTemplateText: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      color: colors.muted,
    },
    newTemplateEdit: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    newTemplateEditText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 14,
      color: colors.accent,
    },
    newTitleBlock: {
      paddingTop: 28,
      paddingHorizontal: 20,
      flexGrow: 1,
    },
    newTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 34,
      lineHeight: 40,
      letterSpacing: -0.8,
      color: colors.ink,
      padding: 0,
    },
    newDivider: {
      height: 1,
      backgroundColor: colors.line,
      marginVertical: 16,
    },
    newBody: {
      flex: 1,
      minHeight: 160,
      padding: 0,
      fontFamily: 'DMSans_400Regular',
      fontSize: 18,
      lineHeight: 27,
      color: colors.ink,
    },
    sortCards: {
      flexDirection: 'row',
      gap: 12,
      paddingTop: 8,
      paddingHorizontal: 4,
    },
    sortCard: {
      flex: 1,
      height: 96,
      padding: 16,
      borderRadius: 24,
      backgroundColor: colors.surface,
      justifyContent: 'space-between',
    },
    sortCardActive: { backgroundColor: colors.accent },
    sortCardTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    sortCardTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 20,
      color: colors.ink,
    },
    sortCardTitleActive: { color: colors.onAccent },
    sortCardDirection: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 15,
      color: colors.muted,
    },
    sortCardDirectionActive: {
      fontFamily: 'DMSans_600SemiBold',
      color: colors.onAccent,
      opacity: 0.8,
    },
    sortHint: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingTop: 18,
      paddingBottom: 6,
      paddingHorizontal: 4,
    },
    sortHintText: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      color: colors.muted,
      flex: 1,
    },
    folderFileRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 4,
      paddingBottom: 10,
    },
    folderFileName: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      color: colors.muted,
    },
    folderNewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      height: 56,
      paddingHorizontal: 16,
      borderRadius: 20,
    },
    folderNewText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
      color: colors.accent,
    },
    folderDivider: {
      height: 1,
      backgroundColor: colors.line,
      marginVertical: 6,
      marginHorizontal: 4,
    },
    folderTree: { maxHeight: 372, flexShrink: 1 },
    folderTreeContent: { paddingBottom: 4 },
    folderTreeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 56,
      marginVertical: 2,
      borderRadius: 20,
    },
    folderTreeRowSelected: { backgroundColor: colors.paper },
    folderChevron: {
      width: 20,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    folderTreeButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      height: 56,
      paddingRight: 16,
    },
    folderTreeName: {
      flex: 1,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
      color: colors.ink,
    },
    folderTreeNameSelected: { color: colors.accent },
    folderTreeNameCurrent: { color: colors.ink },
    folderCurrent: {
      marginLeft: 'auto',
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.muted,
    },
    moveButton: {
      height: 58,
      marginTop: 18,
      borderRadius: 29,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    moveButtonText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
      color: colors.onAccent,
    },
    noteDockShell: {
      backgroundColor: colors.paper,
    },
    noteContentFade: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: 32,
      zIndex: 1,
      elevation: 1,
    },
    noteDock: {
      zIndex: 2,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 28,
    },
    noteFindArea: {
      flex: 1,
      height: 60,
      minWidth: 0,
      borderRadius: 30,
      overflow: 'hidden',
    },
    noteFindTrack: { flexDirection: 'row', height: 60 },
    noteFindPanel: { height: 60, justifyContent: 'center' },
    findDock: {
      height: 60,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingLeft: 16,
      paddingRight: 6,
      borderRadius: 30,
      backgroundColor: colors.surface,
      elevation: 8,
      shadowColor: '#000000',
      shadowOpacity: 0.4,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 },
    },
    findDockInput: {
      flex: 1,
      minWidth: 0,
      color: colors.ink,
      fontFamily: 'DMSans_400Regular',
      fontSize: 16,
      paddingHorizontal: 6,
      paddingVertical: 0,
    },
    findDockCount: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.muted,
      paddingHorizontal: 4,
    },
    noteSegments: {
      flex: 1,
      flexDirection: 'row',
      gap: 4,
      height: 60,
      padding: 6,
      borderRadius: 30,
      backgroundColor: colors.surface,
      elevation: 8,
      shadowColor: '#000000',
      shadowOpacity: 0.4,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 },
    },
    noteSegment: {
      flex: 1,
      height: 48,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    noteSegmentActive: { backgroundColor: colors.accent },
    noteSegmentText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 16,
      color: colors.ink,
    },
    noteSegmentTextActive: { color: colors.onAccent },
    noteDockButton: {
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 8,
      shadowColor: '#000000',
      shadowOpacity: 0.4,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 },
    },
    templateToolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingRight: 12,
      paddingBottom: 10,
      paddingLeft: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    templateTitleBlock: { flex: 1, minWidth: 0 },
    templateTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 20,
      lineHeight: 24,
      letterSpacing: -0.3,
      color: colors.ink,
    },
    templateSubtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
    templateDot: { width: 6, height: 6, borderRadius: 3 },
    templateSubtitle: {
      flexShrink: 1,
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      lineHeight: 16,
      color: colors.muted,
    },
    templateSubtitleError: { color: colors.coral },
    templateSave: {
      height: 40,
      paddingHorizontal: 20,
      borderRadius: 20,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    templateSaveText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 15,
      color: colors.onAccent,
    },
    templateSaveDisabled: { backgroundColor: colors.surface },
    templateSaveTextDisabled: { color: colors.muted },
    templateIntro: {
      paddingTop: 14,
      paddingHorizontal: 20,
      paddingBottom: 4,
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      lineHeight: 21,
      color: colors.muted,
    },
    templatePlaceholder: {
      color: colors.accent,
      backgroundColor: rgba(colors.accent, 0.16),
      borderRadius: 4,
      paddingHorizontal: 2,
    },
    templateErrorCard: {
      position: 'absolute',
      left: 16,
      right: 16,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.soft,
      padding: 14,
      gap: 12,
      elevation: 8,
      zIndex: 8,
      shadowColor: '#000000',
      shadowOpacity: 0.5,
      shadowRadius: 32,
      shadowOffset: { width: 0, height: 12 },
    },
    templateErrorHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    templateErrorText: {
      flex: 1,
      fontFamily: 'DMSans_400Regular',
      fontSize: 15,
      lineHeight: 21,
      color: colors.ink,
    },
    templateErrorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    templateErrorButton: {
      minHeight: 44,
      paddingHorizontal: 16,
      borderRadius: 16,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    templateErrorButtonText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 14,
      color: colors.ink,
    },
    templateFooter: {
      paddingTop: 12,
      paddingHorizontal: 16,
      paddingBottom: 28,
      backgroundColor: colors.paper,
    },
    templatePills: {
      flexDirection: 'row',
      gap: 8,
      height: 60,
      padding: 6,
      borderRadius: 30,
      backgroundColor: colors.surface,
      elevation: 8,
      shadowColor: '#000000',
      shadowOpacity: 0.4,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 },
    },
    templatePill: {
      flex: 1,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.paper,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    templatePillText: {
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 14,
      color: colors.accent,
    },
    folderNewTag: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 12,
      color: colors.muted,
      marginRight: 8,
    },
    folderNewScroll: { flexShrink: 1 },
    folderNewContent: { paddingBottom: 8 },
    folderFieldLabel: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
      letterSpacing: 1.2,
      color: colors.muted,
      paddingHorizontal: 4,
      marginTop: 14,
      marginBottom: 8,
    },
    folderParentRow: {
      minHeight: 64,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      borderRadius: 18,
      backgroundColor: colors.surface,
    },
    folderParentName: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
      color: colors.ink,
    },
    folderParentPath: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.muted,
      marginTop: 2,
    },
    folderSegments: { gap: 8 },
    folderSegmentWrap: { position: 'relative' },
    folderSegmentWrapSub: { marginLeft: 14 },
    folderSegmentBracket: {
      position: 'absolute',
      left: -10,
      top: -10,
      width: 10,
      height: 18,
      borderLeftWidth: 1,
      borderBottomWidth: 1,
      borderColor: colors.line,
      borderBottomLeftRadius: 6,
    },
    folderSegmentRow: {
      height: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      borderRadius: 18,
      borderWidth: 2,
      borderColor: colors.line,
      backgroundColor: colors.paper,
    },
    folderSegmentRowFocused: { borderColor: colors.accent },
    folderSegmentRowError: { borderColor: colors.coral },
    folderSegmentInput: {
      flex: 1,
      minWidth: 0,
      padding: 0,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
      color: colors.ink,
    },
    folderSegmentRemove: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    folderErrorCard: {
      marginTop: 12,
      gap: 10,
      padding: 14,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.soft,
    },
    folderErrorHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    folderErrorText: {
      flex: 1,
      fontFamily: 'DMSans_400Regular',
      fontSize: 15,
      lineHeight: 21,
      color: colors.ink,
    },
    folderErrorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    folderErrorButton: {
      minHeight: 40,
      paddingHorizontal: 14,
      borderRadius: 14,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    folderErrorButtonText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 14,
      color: colors.ink,
    },
    folderAddSub: {
      height: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 4,
    },
    folderAddSubText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
      color: colors.accent,
    },
    folderPathPreview: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      lineHeight: 18,
      color: colors.muted,
      paddingHorizontal: 4,
      marginTop: 8,
      marginBottom: 4,
    },
    folderPathLast: {
      fontFamily: 'DMSans_600SemiBold',
      color: colors.accent,
    },
    moveButtonDisabled: { backgroundColor: colors.surface },
    moveButtonTextDisabled: { color: colors.muted },
    appearanceToolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingTop: 14,
      paddingRight: 12,
      paddingBottom: 10,
      paddingLeft: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    appearanceTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 22,
      letterSpacing: -0.4,
      color: colors.ink,
    },
    appearanceBody: {
      paddingHorizontal: 20,
      paddingBottom: 48,
    },
    settingsSection: {
      paddingBottom: 12,
    },
    settingsLabel: {
      fontFamily: 'DMSans_600SemiBold',
      color: colors.muted,
      fontSize: 12,
      letterSpacing: 1.2,
      marginTop: 14,
      marginBottom: 8,
      paddingHorizontal: 4,
    },
    modeRow: {
      flexDirection: 'row',
      gap: 4,
      padding: 4,
      borderRadius: 26,
    },
    modeButton: {
      flex: 1,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
    },
    modeButtonActive: { backgroundColor: colors.accent },
    modeText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 16,
      color: colors.ink,
    },
    modeTextActive: { color: colors.onAccent },
    flavorRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      paddingHorizontal: 4,
    },
    flavorLight: { width: 78 },
    flavorDivider: {
      width: 1,
      alignSelf: 'stretch',
      backgroundColor: colors.line,
      marginHorizontal: 4,
    },
    flavorDarkRow: {
      flexDirection: 'row',
      gap: 8,
    },
    flavorGroupLabel: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
      letterSpacing: 1.2,
      color: colors.muted,
      marginBottom: 6,
      marginLeft: 2,
    },
    flavorCard: { width: 78 },
    flavorPreview: {
      height: 60,
      borderRadius: 18,
      borderWidth: 2,
      borderColor: colors.line,
      padding: 10,
      gap: 6,
      alignItems: 'flex-start',
    },
    flavorDot: {
      width: 20,
      height: 20,
      borderRadius: 10,
    },
    flavorBar: {
      width: 44,
      height: 6,
      borderRadius: 3,
    },
    flavorText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 13,
      color: colors.muted,
      marginTop: 6,
      textAlign: 'center',
    },
    flavorTextSelected: { color: colors.ink },
    accentLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingRight: 4,
    },
    accentValue: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 13,
      color: colors.ink,
      marginTop: 14,
      marginBottom: 8,
    },
    accentGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      rowGap: 14,
      padding: 4,
    },
    accentPressable: {
      width: '14.2857%',
      height: 40,
      alignItems: 'center',
    },
    accentSwatch: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    selectedRing: {
      position: 'absolute',
      top: -5,
      left: -5,
      right: -5,
      bottom: -5,
      borderRadius: 25,
      borderWidth: 2,
      borderColor: colors.ink,
    },
    customRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      height: 56,
      marginTop: 12,
      paddingLeft: 12,
      paddingRight: 14,
      borderRadius: 18,
      backgroundColor: colors.soft,
    },
    customCircle: {
      width: 34,
      height: 34,
      borderRadius: 17,
      borderWidth: 2,
      borderStyle: 'dashed',
      borderColor: colors.muted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    customTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 16,
      color: colors.ink,
    },
    customHex: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.muted,
      marginTop: 1,
    },
    customEdit: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    customEditText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 14,
      color: colors.accent,
    },
    amoledRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      marginTop: 14,
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: 20,
      backgroundColor: colors.soft,
    },
    amoledTitle: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
      color: colors.ink,
    },
    amoledBody: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.muted,
      marginTop: 2,
    },
    toggleTrack: {
      width: 52,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.surface,
      justifyContent: 'center',
      padding: 4,
    },
    toggleThumb: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: colors.muted,
    },
    toggleThumbOn: { marginLeft: 'auto' },
    colorSheetBody: { flexGrow: 1 },
    colorSection: { paddingTop: 16, paddingHorizontal: 4 },
    colorLabel: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
      letterSpacing: 1.2,
      color: colors.muted,
      marginBottom: 8,
    },
    hexField: {
      height: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      borderRadius: 18,
      backgroundColor: colors.paper,
      borderWidth: 2,
    },
    hexSwatch: {
      width: 28,
      height: 28,
      borderRadius: 14,
    },
    hexHash: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 18,
      color: colors.muted,
    },
    hexInput: {
      flex: 1,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 18,
      letterSpacing: 1,
      color: colors.ink,
      padding: 0,
    },
    sliderSection: { paddingTop: 16, paddingHorizontal: 4 },
    sliderLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    sliderLabel: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 12,
      letterSpacing: 1.2,
      color: colors.muted,
    },
    sliderValue: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 13,
      color: colors.ink,
    },
    sliderTrack: {
      height: 14,
      borderRadius: 7,
      justifyContent: 'center',
    },
    sliderKnob: {
      position: 'absolute',
      top: -7,
      marginLeft: -14,
      width: 28,
      height: 28,
      borderRadius: 14,
      borderWidth: 3,
      borderColor: colors.ink,
      elevation: 4,
      shadowColor: '#000000',
      shadowOpacity: 0.5,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
    },
    contrastRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingTop: 16,
      paddingHorizontal: 4,
    },
    contrastText: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 14,
      color: colors.muted,
    },
    useColorButton: {
      height: 58,
      marginTop: 'auto',
      marginBottom: 90,
      borderRadius: 29,
      alignItems: 'center',
      justifyContent: 'center',
    },
    useColorText: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 17,
    },
  })
}

const styleSheets = new WeakMap<ThemeColors, ReturnType<typeof makeStyles>>()

function useStyles() {
  const { colors } = useTheme()
  return useMemo(() => {
    const cached = styleSheets.get(colors)
    if (cached) return cached
    // Every mounted row and sheet shares one sheet per theme instead of building its own.
    const styles = makeStyles(colors)
    styleSheets.set(colors, styles)
    return styles
  }, [colors])
}
