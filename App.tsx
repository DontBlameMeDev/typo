import { Ionicons } from '@expo/vector-icons'
import { DMSans_400Regular, DMSans_600SemiBold, useFonts } from '@expo-google-fonts/dm-sans'
import { Newsreader_400Regular, Newsreader_400Regular_Italic } from '@expo-google-fonts/newsreader'
import * as Sharing from 'expo-sharing'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import Pdf from 'react-native-pdf'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { searchNotes } from './src/core'
import type { Note, SearchMode, SearchResult, Vault } from './src/types'
import {
  createNote,
  forgetVault,
  loadSavedVault,
  pickVault,
  preparePdf,
  releasePdf,
  saveNote,
  scanVault,
} from './src/vault'

const C = {
  paper: '#F6F4EE',
  ink: '#202A25',
  muted: '#626B60',
  line: '#DEDCCE',
  sage: '#DCE9C8',
  soft: '#ECEEE4',
  white: '#FFFEFA',
  coral: '#A84E39',
  coralSoft: '#F4E7DF',
}
const fonts = {
  DMSans_400Regular,
  DMSans_600SemiBold,
  Newsreader_400Regular,
  Newsreader_400Regular_Italic,
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.'

function Icon({
  name,
  size = 21,
  color = C.ink,
}: {
  name: React.ComponentProps<typeof Ionicons>['name']
  size?: number
  color?: string
}) {
  return <Ionicons name={name} size={size} color={color} />
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
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [s.action, pressed && s.pressed, (disabled || busy) && s.disabled]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={C.ink} />
      ) : icon ? (
        <Icon name={icon} size={19} />
      ) : null}
      <Text style={s.actionText}>{label}</Text>
    </Pressable>
  )
}
function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <View accessibilityLiveRegion="polite" style={s.error}>
      <Icon name="alert-circle-outline" color={C.coral} />
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
function confirmDiscard(action: () => void) {
  Alert.alert('Leave unsaved changes?', 'Your changes haven’t been saved to the notes folder.', [
    { text: 'Keep editing', style: 'cancel' },
    { text: 'Discard changes', style: 'destructive', onPress: action },
  ])
}

export default function App() {
  const [loaded, fontError] = useFonts(fonts)
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      {loaded || fontError ? (
        <Library />
      ) : (
        <View style={s.loadingScreen}>
          <ActivityIndicator color={C.ink} />
        </View>
      )}
    </SafeAreaProvider>
  )
}

function Library() {
  const [vault, setVault] = useState<Vault | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [restoring, setRestoring] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [picking, setPicking] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('all')
  const [selected, setSelected] = useState<SearchResult | null>(null)
  const [creating, setCreating] = useState(false)
  const [stale, setStale] = useState<Set<string>>(new Set())
  const generation = useRef(0)
  const mounted = useRef(true)
  const scanningRef = useRef(false)
  const vaultRef = useRef<Vault | null>(null)
  const modalOpen = useRef(false)
  modalOpen.current = !!selected || creating

  const index = useCallback(async (target: Vault) => {
    const request = ++generation.current
    scanningRef.current = true
    setScanning(true)
    setProgress(0)
    setError(null)
    try {
      const result = await scanVault(target, (count: number) => {
        if (mounted.current && request === generation.current) setProgress(count)
      })
      if (mounted.current && request === generation.current) setNotes(result)
    } catch (cause) {
      if (mounted.current && request === generation.current) setError(errorText(cause))
    } finally {
      if (mounted.current && request === generation.current) {
        scanningRef.current = false
        setScanning(false)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void (async () => {
      try {
        const saved = await loadSavedVault()
        if (cancelled) return
        if (saved) {
          setVault(saved)
          vaultRef.current = saved
          await index(saved)
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
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && vaultRef.current && !modalOpen.current && !scanningRef.current)
        void index(vaultRef.current)
    })
    return () => listener.remove()
  }, [index])

  async function chooseVault() {
    if (picking || restoring) return
    setPicking(true)
    setError(null)
    try {
      const next = await pickVault()
      if (!mounted.current || !next) return
      generation.current++
      setVault(next)
      vaultRef.current = next
      setNotes([])
      setQuery('')
      setStale(new Set())
      await index(next)
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setPicking(false)
    }
  }

  function folderOptions() {
    Alert.alert(
      vault?.name || 'Notes folder',
      'Your files stay in your folder. Switching or disconnecting never deletes them.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Switch folder', onPress: () => void chooseVault() },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await forgetVault()
                if (!mounted.current) return
                generation.current++
                scanningRef.current = false
                setScanning(false)
                setVault(null)
                vaultRef.current = null
                setNotes([])
                setError(null)
              } catch (cause) {
                if (mounted.current) setError(errorText(cause))
              }
            })()
          },
        },
      ]
    )
  }

  const results = useMemo(() => searchNotes(notes, query, mode), [notes, query, mode])
  const isSearching = query.trim().length > 0
  const stopIndex = () => {
    generation.current++
    scanningRef.current = false
    setScanning(false)
  }
  const updateNote = (note: Note) => {
    stopIndex()
    setNotes((previous) => previous.map((item) => (item.uri === note.uri ? note : item)))
    setStale((previous) => new Set(previous).add(note.uri))
  }

  return (
    <SafeAreaView style={s.screen} edges={['top', 'left', 'right', 'bottom']}>
      <View style={s.header}>
        <View style={s.brandRow}>
          <View style={s.brandLockup}>
            <View style={s.brandMark}>
              <Text style={s.markText}>t.</Text>
            </View>
            <Text style={s.brand}>Typo</Text>
          </View>
        </View>
        {vault && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Notes folder: ${vault.name}. Change folder`}
            disabled={picking}
            onPress={folderOptions}
            style={s.folderButton}
          >
            <Icon name="folder-open-outline" size={16} />
            <Text numberOfLines={1} style={s.folderName}>
              {vault.name}
            </Text>
            {picking ? (
              <ActivityIndicator size="small" color={C.muted} />
            ) : (
              <Icon name="chevron-down" size={15} />
            )}
          </Pressable>
        )}
      </View>
      {error && (
        <View style={s.errorInset}>
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </View>
      )}
      {restoring ? (
        <View style={s.center}>
          <ActivityIndicator color={C.ink} />
          <Text style={s.muted}>Opening your workspace…</Text>
        </View>
      ) : !vault ? (
        <ScrollView contentContainerStyle={s.onboarding} keyboardShouldPersistTaps="handled">
          <View style={s.illustration}>
            <View style={s.paperBack} />
            <View style={s.paperFront}>
              <Text style={s.paperEyebrow}>A NOTE TO KEEP</Text>
              <Text style={s.paperTitle}>Make room{'\n'}for an idea.</Text>
              <View style={s.ruleShort} />
              <View style={s.rule} />
              <View style={s.rule} />
              <Text style={s.paperFoot}>Yours, from the first word.</Text>
            </View>
            <View style={s.penBadge}>
              <Icon name="pencil-outline" size={25} />
            </View>
          </View>
          <Text style={s.eyebrow}>YOUR WORDS. YOUR FOLDER.</Text>
          <Text style={s.welcomeTitle}>Good things start{'\n'}with a little note.</Text>
          <Text style={s.welcomeBody}>
            A quiet home for your Typst notes.{'\n'}Write, find, and keep your ideas close.
          </Text>
          <Action
            label="Open notes folder"
            icon="folder-open-outline"
            onPress={() => void chooseVault()}
            busy={picking}
          />
          <View style={s.privacy}>
            <Icon name="lock-closed-outline" size={15} color={C.muted} />
            <Text style={s.privacyText}>
              No account. No upload. Just local files.{'\n'}Choose a folder on your device to begin.
            </Text>
          </View>
        </ScrollView>
      ) : (
        <>
          <View style={s.libraryTop}>
            <View style={s.titleRow}>
              <Text style={s.pageTitle}>Your notes</Text>
              <Text style={s.titleAside}>A thought, kept.</Text>
            </View>
            <View style={s.search}>
              <Icon name="search-outline" color={C.muted} />
              <TextInput
                accessibilityLabel="Search notes"
                placeholder="Find a thought…"
                placeholderTextColor={C.muted}
                value={query}
                onChangeText={setQuery}
                style={s.searchInput}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
              />
              {query.length > 0 && (
                <IconButton name="close-circle" label="Clear search" onPress={() => setQuery('')} />
              )}
            </View>
            <View style={{ marginTop: 16 }}>
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
                {scanning
                  ? `INDEXING · ${progress} FOUND`
                  : `${results.length} ${isSearching ? 'RESULT' : 'NOTE'}${results.length === 1 ? '' : 'S'}`}
              </Text>
              {scanning ? (
                <ActivityIndicator size="small" color={C.muted} />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Refresh notes"
                  onPress={() => void index(vault)}
                  style={s.iconButton}
                >
                  <Icon name="refresh-outline" size={17} color={C.muted} />
                </Pressable>
              )}
            </View>
          </View>
          <FlatList
            data={results}
            keyExtractor={(item) => item.note.uri}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={[s.list, results.length === 0 && s.emptyList]}
            refreshControl={
              <RefreshControl
                refreshing={scanning}
                onRefresh={() => void index(vault)}
                tintColor={C.ink}
                colors={[C.ink]}
              />
            }
            renderItem={({ item }) => <NoteRow result={item} onPress={() => setSelected(item)} />}
            ListEmptyComponent={
              <View style={s.empty}>
                <View style={s.emptyIcon}>
                  <Icon name={isSearching ? 'search-outline' : 'document-text-outline'} size={28} />
                </View>
                <Text style={s.emptyTitle}>
                  {scanning
                    ? 'Gathering your thoughts…'
                    : isSearching
                      ? 'No notes found.'
                      : 'A fresh page awaits.'}
                </Text>
                <Text style={s.emptyBody}>
                  {scanning
                    ? 'Looking for .typ files in your folder.'
                    : isSearching
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
                      onPress={() => setCreating(true)}
                    />
                  ))}
              </View>
            }
            ListFooterComponent={
              results.length > 0 ? (
                <Text style={s.listFooter}>A place for everything on your mind.</Text>
              ) : undefined
            }
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create a new note"
            onPress={() => setCreating(true)}
            style={({ pressed }) => [s.fab, pressed && s.pressed]}
          >
            <Icon name="add" size={23} />
            <Text style={s.fabText}>New note</Text>
          </Pressable>
        </>
      )}
      {selected && (
        <NoteDetail
          key={selected.note.uri}
          note={selected.note}
          initialLine={selected.line}
          initialQuery={isSearching ? query : ''}
          initiallyStale={stale.has(selected.note.uri)}
          onClose={() => setSelected(null)}
          onSave={updateNote}
        />
      )}
      {creating && vault && (
        <NewNote
          vault={vault}
          onClose={() => setCreating(false)}
          onCreated={(note) => {
            stopIndex()
            setNotes((previous) => [...previous, note].sort((a, b) => a.path.localeCompare(b.path)))
            setCreating(false)
            setSelected({ note })
          }}
        />
      )}
    </SafeAreaView>
  )
}

function NoteRow({ result, onPress }: { result: SearchResult; onPress: () => void }) {
  const { note, snippet, line } = result
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${note.title}, ${note.path}${note.pdfUri ? ', PDF available' : ''}`}
      onPress={onPress}
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
      <View style={s.rowEnd}>
        {note.pdfUri && (
          <View style={s.pdfBadge}>
            <Text style={s.pdfBadgeText}>PDF</Text>
          </View>
        )}
        <Icon name="chevron-forward" size={16} color={C.muted} />
      </View>
    </Pressable>
  )
}

function NoteDetail({
  note,
  initialLine,
  initialQuery,
  initiallyStale,
  onClose,
  onSave,
}: {
  note: Note
  initialLine?: number
  initialQuery: string
  initiallyStale: boolean
  onClose: () => void
  onSave: (note: Note) => void
}) {
  const [savedNote, setSavedNote] = useState(note)
  const [source, setSource] = useState(note.source)
  const [mode, setMode] = useState<'source' | 'pdf'>('source')
  const [find, setFind] = useState(initialQuery)
  const [findOpen, setFindOpen] = useState(!!initialQuery || !!initialLine)
  const [matchIndex, setMatchIndex] = useState(0)
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>()
  const [saving, setSaving] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [pdfUri, setPdfUri] = useState<string | null>(null)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [stale, setStale] = useState(initiallyStale)
  const alive = useRef(true)
  const editor = useRef<React.ComponentRef<typeof TextInput>>(null)
  const dirty = source !== savedNote.source
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
    const firstMatch = initialQuery
      ? note.source.toLocaleLowerCase().indexOf(initialQuery.toLocaleLowerCase())
      : -1
    if (firstMatch >= 0) {
      setSelection({ start: firstMatch, end: firstMatch + initialQuery.length })
    } else if (initialLine) {
      const lines = note.source.split('\n')
      const start =
        lines.slice(0, Math.max(0, initialLine - 1)).join('\n').length + (initialLine > 1 ? 1 : 0)
      setSelection({ start, end: start + (lines[initialLine - 1]?.length || 0) })
    }
  }, [initialLine, initialQuery, note.source])
  useEffect(() => {
    if (mode !== 'pdf' || !savedNote.pdfUri) return
    let cancelled = false
    let localCopy: string | null = null
    setPdfLoading(true)
    setPdfError(null)
    setPdfUri(null)
    void preparePdf(savedNote)
      .then((uri: string) => {
        if (cancelled) void releasePdf(uri).catch(() => {})
        else {
          localCopy = uri
          setPdfUri(uri)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setPdfError(errorText(cause))
      })
      .finally(() => {
        if (!cancelled) setPdfLoading(false)
      })
    return () => {
      cancelled = true
      if (localCopy) void releasePdf(localCopy).catch(() => {})
    }
  }, [mode, savedNote])

  const close = () => {
    if (saving || sharing) return
    if (dirty) confirmDiscard(onClose)
    else onClose()
  }
  function switchMode(next: 'source' | 'pdf') {
    if (next === mode || saving || sharing) return
    if (dirty && next === 'pdf')
      confirmDiscard(() => {
        setSource(savedNote.source)
        setMode(next)
      })
    else setMode(next)
  }
  async function save() {
    if (saving || !dirty) return
    setSaving(true)
    setError(null)
    try {
      const saved = await saveNote(savedNote, source)
      if (!alive.current) return
      const updated = { ...savedNote, ...saved }
      setSavedNote(updated)
      setStale(true)
      onSave(updated)
    } catch (cause) {
      if (alive.current) setError(errorText(cause))
    } finally {
      if (alive.current) setSaving(false)
    }
  }
  async function share() {
    if (sharing || !savedNote.pdfUri) return
    setSharing(true)
    setError(null)
    try {
      if (!(await Sharing.isAvailableAsync()))
        throw new Error('Sharing is not available on this device.')
      const uri = await preparePdf(savedNote)
      if (alive.current)
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: savedNote.title,
          UTI: 'com.adobe.pdf',
        })
    } catch (cause) {
      if (alive.current) setError(errorText(cause))
    } finally {
      if (alive.current) setSharing(false)
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
  const selectedLine = selection ? source.slice(0, selection.start).split('\n').length : null

  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={close}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <SafeAreaView style={s.screen}>
        <KeyboardAvoidingView
          style={s.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={s.detailToolbar}>
            <IconButton
              name="arrow-back"
              label="Back to notes"
              onPress={close}
              disabled={saving || sharing}
            />
            <View style={s.toolbarTitle}>
              <Text numberOfLines={1} style={s.toolbarHeading}>
                {savedNote.title}
              </Text>
              <Text numberOfLines={1} style={s.notePath}>
                {savedNote.path}
              </Text>
            </View>
            {mode === 'source' ? (
              <Action
                label={saving ? 'Saving' : 'Save'}
                onPress={() => void save()}
                busy={saving}
                disabled={!dirty}
              />
            ) : (
              <IconButton
                name="share-outline"
                label={sharing ? 'Preparing PDF for sharing' : 'Share PDF'}
                onPress={() => void share()}
                disabled={!savedNote.pdfUri || sharing}
              />
            )}
          </View>
          <View style={s.detailControls}>
            <Segments
              options={[
                { label: 'Source', value: 'source' },
                { label: 'PDF', value: 'pdf' },
              ]}
              value={mode}
              onChange={switchMode}
            />
          </View>
          {error && (
            <View style={s.errorInset}>
              <ErrorBanner message={error} onDismiss={() => setError(null)} />
            </View>
          )}
          {mode === 'source' ? (
            <>
              <View style={s.editorMeta}>
                <Text style={s.eyebrow}>
                  {dirty ? 'UNSAVED CHANGES' : 'TYPST SOURCE'}
                  {saving ? ' · SAVING' : ''}
                </Text>
                <IconButton
                  name={findOpen ? 'close' : 'search-outline'}
                  label={findOpen ? 'Close find' : 'Find in note'}
                  onPress={() => {
                    setFindOpen(!findOpen)
                    setSelection(undefined)
                  }}
                />
              </View>
              {findOpen && (
                <View style={s.findBar}>
                  <Icon name="search-outline" size={18} color={C.muted} />
                  <TextInput
                    accessibilityLabel="Find in source"
                    placeholder="Find in this note"
                    placeholderTextColor={C.muted}
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
              <TextInput
                ref={editor}
                accessibilityLabel="Note source"
                multiline
                textAlignVertical="top"
                value={source}
                onChangeText={(text) => {
                  setSource(text)
                  setSelection(undefined)
                }}
                selection={selection}
                selectionColor="#AEC68D"
                editable={!saving}
                style={s.sourceEditor}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                placeholder="A place to begin…"
                placeholderTextColor={C.muted}
              />
              <View style={s.editorFooter}>
                <View style={s.inline}>
                  <View style={[s.dot, dirty && { backgroundColor: C.coral }]} />
                  <Text style={s.caption}>{dirty ? 'Not saved yet' : 'Saved in your folder'}</Text>
                </View>
                <Text style={s.caption}>
                  {selectedLine ? `Line ${selectedLine} · ` : ''}
                  {source.split('\n').length} lines
                </Text>
              </View>
            </>
          ) : (
            <View style={s.flex}>
              {stale && savedNote.pdfUri && (
                <View style={s.warning}>
                  <Icon name="time-outline" size={18} color={C.coral} />
                  <Text style={s.warningText}>
                    This PDF may be out of date. Compile on desktop and sync the out folder to see
                    your latest edits.
                  </Text>
                </View>
              )}
              {!savedNote.pdfUri ? (
                <View style={s.pdfEmpty}>
                  <View style={s.emptyIcon}>
                    <Icon name="document-outline" size={32} />
                  </View>
                  <Text style={s.emptyTitle}>No PDF yet.</Text>
                  <Text style={s.emptyBody}>
                    PDF not generated yet. Compile on desktop and sync the out folder; on-device
                    compilation is planned for v1.
                  </Text>
                  <View style={s.outLabel}>
                    <Icon name="folder-outline" size={16} color={C.muted} />
                    <Text style={s.caption}>Looking for a matching PDF in out/</Text>
                  </View>
                </View>
              ) : pdfLoading ? (
                <View style={s.center}>
                  <ActivityIndicator color={C.ink} />
                  <Text style={s.muted}>Opening your PDF…</Text>
                </View>
              ) : pdfError ? (
                <View style={s.errorInset}>
                  <ErrorBanner message={pdfError} />
                  <Action
                    label="Try again"
                    onPress={() => {
                      setSavedNote({ ...savedNote })
                    }}
                  />
                </View>
              ) : pdfUri ? (
                <Pdf
                  source={{ uri: pdfUri, cache: false }}
                  trustAllCerts={false}
                  style={s.pdf}
                  onError={(cause) => setPdfError(errorText(cause))}
                  renderActivityIndicator={() => <ActivityIndicator color={C.ink} />}
                />
              ) : null}
            </View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

function NewNote({
  vault,
  onClose,
  onCreated,
}: {
  vault: Vault
  onClose: () => void
  onCreated: (note: Note) => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const close = () => {
    if (!saving) {
      if (title || body) confirmDiscard(onClose)
      else onClose()
    }
  }
  async function create() {
    if (!title.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const note = await createNote(vault, title.trim(), body)
      if (alive.current) onCreated(note)
    } catch (cause) {
      if (alive.current) setError(errorText(cause))
    } finally {
      if (alive.current) setSaving(false)
    }
  }
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={close}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <SafeAreaView style={s.screen}>
        <KeyboardAvoidingView
          style={s.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={s.detailToolbar}>
            <IconButton name="close" label="Close new note" onPress={close} disabled={saving} />
            <Text style={[s.toolbarHeading, s.flex]}>New note</Text>
          </View>
          <View style={s.newIntro}>
            <Text style={s.eyebrow}>A FRESH START</Text>
            <Text style={s.newHeading}>What’s on your mind?</Text>
            <View style={s.inline}>
              <Icon name="folder-outline" size={15} color={C.muted} />
              <Text numberOfLines={1} style={[s.caption, s.flex]}>
                Saving to {vault.name}
              </Text>
            </View>
          </View>
          {error && (
            <View style={s.errorInset}>
              <ErrorBanner message={error} onDismiss={() => setError(null)} />
            </View>
          )}
          <TextInput
            accessibilityLabel="Note title"
            placeholder="Give it a title"
            placeholderTextColor={C.muted}
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
            placeholderTextColor={C.muted}
            value={body}
            onChangeText={setBody}
            editable={!saving}
            multiline
            textAlignVertical="top"
            style={s.newBody}
          />
          <View style={s.createFooter}>
            <Action
              label={saving ? 'Creating note…' : 'Create note'}
              busy={saving}
              disabled={!title.trim()}
              icon="add"
              onPress={() => void create()}
            />
            <Text style={[s.caption, { textAlign: 'center' }]}>
              Saved as a .typ file in your folder.
            </Text>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: C.paper },
  loadingScreen: {
    flex: 1,
    backgroundColor: C.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandLockup: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  brandMark: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: C.ink,
    justifyContent: 'center',
    alignItems: 'center',
  },
  markText: { fontFamily: 'Newsreader_400Regular', color: C.sage, fontSize: 28, lineHeight: 32 },
  brand: { fontFamily: 'DMSans_600SemiBold', color: C.ink, fontSize: 24, letterSpacing: -1 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#7D9567' },
  folderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    gap: 8,
    marginTop: 8,
    minHeight: 44,
  },
  folderName: { fontFamily: 'DMSans_400Regular', fontSize: 14, color: C.ink, flexShrink: 1 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 16,
    backgroundColor: C.sage,
    paddingVertical: 12,
    paddingHorizontal: 20,
    minHeight: 48,
  },
  actionText: { fontFamily: 'DMSans_600SemiBold', color: C.ink, fontSize: 14 },
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
  muted: { fontFamily: 'DMSans_400Regular', fontSize: 14, color: C.muted },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  errorInset: { paddingHorizontal: 24, paddingVertical: 8 },
  error: {
    backgroundColor: C.coralSoft,
    borderRadius: 14,
    padding: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  errorText: {
    flex: 1,
    color: C.coral,
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
    backgroundColor: '#E4E8D6',
    borderRadius: 8,
    transform: [{ rotate: '-10deg' }],
    left: 32,
    top: 14,
  },
  paperFront: {
    width: 178,
    height: 211,
    backgroundColor: C.white,
    borderWidth: 1,
    borderColor: '#E5E2D7',
    borderRadius: 7,
    paddingHorizontal: 19,
    paddingTop: 25,
    transform: [{ rotate: '5deg' }],
  },
  paperEyebrow: {
    fontFamily: 'DMSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: C.muted,
    marginBottom: 18,
  },
  paperTitle: {
    fontFamily: 'Newsreader_400Regular',
    fontSize: 18,
    lineHeight: 24,
    color: C.ink,
    marginBottom: 15,
  },
  ruleShort: { width: '68%', height: 1, backgroundColor: C.line, marginBottom: 9 },
  rule: { width: '95%', height: 1, backgroundColor: C.line, marginBottom: 9 },
  paperFoot: {
    fontFamily: 'Newsreader_400Regular_Italic',
    color: C.muted,
    fontSize: 12,
    marginTop: 12,
  },
  penBadge: {
    position: 'absolute',
    bottom: 1,
    right: 8,
    backgroundColor: C.sage,
    borderColor: C.paper,
    borderWidth: 6,
    width: 65,
    height: 65,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-10deg' }],
  },
  eyebrow: { fontFamily: 'DMSans_600SemiBold', color: C.muted, fontSize: 12, letterSpacing: 1.2 },
  welcomeTitle: {
    fontFamily: 'Newsreader_400Regular',
    color: C.ink,
    textAlign: 'center',
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -0.9,
    marginTop: 17,
  },
  welcomeBody: {
    fontFamily: 'DMSans_400Regular',
    color: C.muted,
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 23,
    marginTop: 16,
    marginBottom: 28,
  },
  privacy: {
    marginTop: 23,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    alignItems: 'flex-start',
  },
  privacyText: {
    color: C.muted,
    textAlign: 'center',
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
    lineHeight: 20,
  },
  libraryTop: { paddingHorizontal: 24, paddingTop: 24 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 24,
  },
  pageTitle: { fontFamily: 'Newsreader_400Regular', fontSize: 36, letterSpacing: -1, color: C.ink },
  titleAside: {
    fontFamily: 'Newsreader_400Regular_Italic',
    fontSize: 14,
    color: C.muted,
    flexShrink: 1,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.soft,
    borderRadius: 16,
    paddingLeft: 15,
    minHeight: 52,
    paddingRight: 5,
  },
  searchInput: {
    flex: 1,
    color: C.ink,
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  segments: { flexDirection: 'row', padding: 4, backgroundColor: C.soft, borderRadius: 13, gap: 3 },
  segment: {
    flex: 1,
    minHeight: 44,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: { backgroundColor: C.white },
  segmentText: { fontFamily: 'DMSans_400Regular', fontSize: 14, color: C.muted },
  segmentTextActive: { color: C.ink, fontFamily: 'DMSans_600SemiBold' },
  listMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 8,
    height: 44,
  },
  list: { paddingHorizontal: 24, paddingBottom: 106 },
  emptyList: { flexGrow: 1 },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 20,
    borderBottomColor: C.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowPressed: { backgroundColor: C.soft },
  noteGlyph: {
    width: 39,
    height: 45,
    borderRadius: 11,
    backgroundColor: C.soft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteInfo: { flex: 1, gap: 5 },
  noteTitle: {
    fontFamily: 'DMSans_600SemiBold',
    fontSize: 18,
    color: C.ink,
    lineHeight: 24,
    letterSpacing: -0.3,
  },
  notePath: { fontFamily: 'DMSans_400Regular', fontSize: 12, color: C.muted, lineHeight: 20 },
  snippet: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
    lineHeight: 18,
    color: C.muted,
    marginTop: 3,
  },
  rowEnd: { alignItems: 'flex-end', gap: 10 },
  pdfBadge: { backgroundColor: C.sage, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5 },
  pdfBadgeText: {
    fontFamily: 'DMSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 0.4,
    color: C.ink,
  },
  fab: {
    position: 'absolute',
    right: 24,
    bottom: 24,
    borderRadius: 19,
    paddingHorizontal: 20,
    minHeight: 56,
    backgroundColor: C.sage,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    elevation: 3,
    shadowColor: '#596B47',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  fabText: { fontFamily: 'DMSans_600SemiBold', fontSize: 14, color: C.ink },
  listFooter: {
    fontFamily: 'Newsreader_400Regular_Italic',
    color: C.muted,
    fontSize: 14,
    textAlign: 'center',
    paddingTop: 28,
  },
  empty: { alignItems: 'center', paddingHorizontal: 20, paddingTop: 44, gap: 17 },
  emptyIcon: {
    width: 66,
    height: 66,
    backgroundColor: C.soft,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: {
    fontFamily: 'Newsreader_400Regular',
    fontSize: 36,
    lineHeight: 40,
    color: C.ink,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  emptyBody: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    lineHeight: 23,
    color: C.muted,
    textAlign: 'center',
    maxWidth: 310,
  },
  textLink: { padding: 12 },
  linkText: { fontFamily: 'DMSans_600SemiBold', color: C.ink, fontSize: 14 },
  detailToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
  },
  toolbarTitle: { flex: 1, gap: 3 },
  toolbarHeading: { fontFamily: 'DMSans_600SemiBold', color: C.ink, fontSize: 18 },
  detailControls: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 12 },
  editorMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    minHeight: 44,
  },
  findBar: {
    marginHorizontal: 20,
    borderRadius: 12,
    paddingLeft: 12,
    backgroundColor: C.soft,
    flexDirection: 'row',
    alignItems: 'center',
  },
  findInput: {
    flex: 1,
    minWidth: 40,
    color: C.ink,
    fontFamily: 'DMSans_400Regular',
    paddingVertical: 12,
    paddingHorizontal: 8,
    fontSize: 14,
  },
  findCount: { fontSize: 12, color: C.muted, fontFamily: 'DMSans_400Regular' },
  sourceEditor: {
    flex: 1,
    paddingHorizontal: 25,
    paddingTop: 16,
    paddingBottom: 24,
    color: C.ink,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14,
    lineHeight: 24,
  },
  editorFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 15,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.line,
    gap: 7,
  },
  caption: { fontFamily: 'DMSans_400Regular', fontSize: 12, color: C.muted, lineHeight: 20 },
  pdf: { flex: 1, width: '100%', backgroundColor: '#E9E7E0' },
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
    backgroundColor: C.coralSoft,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 9,
    marginHorizontal: 20,
    marginBottom: 12,
    borderRadius: 12,
  },
  warningText: {
    color: C.coral,
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
    borderTopColor: C.line,
  },
  newIntro: { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 24, gap: 16 },
  newHeading: {
    fontFamily: 'Newsreader_400Regular',
    color: C.ink,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -0.8,
  },
  newTitle: {
    marginHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
    fontFamily: 'Newsreader_400Regular',
    fontSize: 18,
    color: C.ink,
  },
  newBody: {
    flex: 1,
    paddingHorizontal: 24,
    paddingVertical: 24,
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    lineHeight: 24,
    color: C.ink,
  },
})
