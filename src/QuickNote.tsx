import { DMSans_400Regular, DMSans_600SemiBold, useFonts } from '@expo-google-fonts/dm-sans'
import * as SplashScreen from 'expo-splash-screen'
import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context'
import { ErrorBanner } from './ErrorBanner'
import { finishQuickNote } from './quick-note-native'
import { ThemeProvider, useTheme } from './theme'
import type { Vault } from './types'
import { createNote, readSavedVault, readTemplate } from './vault'

const fonts = { DMSans_400Regular, DMSans_600SemiBold }

export default function QuickNoteRoot() {
  const [loaded, fontError] = useFonts(fonts)
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => {})
  }, [])
  if (!loaded && !fontError) return null
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <ThemeProvider>
        <QuickNote />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}

type VaultState =
  | { kind: 'loading' }
  | { kind: 'ready'; vault: Vault }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

type TemplateResult = { source: string } | { error: unknown }

function QuickNote() {
  const { colors, ready } = useTheme()
  const s = useStyles()
  const insets = useSafeAreaInsets()
  const [state, setState] = useState<VaultState>({ kind: 'loading' })
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<React.ComponentRef<typeof TextInput>>(null)
  const template = useRef<Promise<TemplateResult> | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void (async () => {
      try {
        const vault = await readSavedVault()
        if (!alive.current) return
        if (!vault) {
          setState({ kind: 'missing' })
          return
        }
        // Start the template read now. The form does not wait for it, so the
        // first frame never sits on a SAF round trip.
        template.current = readTemplate(vault).then(
          (source) => ({ source }),
          (cause) => ({ error: cause })
        )
        setState({ kind: 'ready', vault })
      } catch (cause) {
        if (alive.current) setState({ kind: 'error', message: message(cause) })
      }
    })()
    return () => {
      alive.current = false
    }
  }, [])

  const close = useCallback(() => {
    Keyboard.dismiss()
    finishQuickNote()
  }, [])

  // A save can finish after the activity closes, so Back must not dismiss the
  // sheet while it runs. Close is disabled for the same reason.
  useEffect(() => {
    if (!saving) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true)
    return () => subscription.remove()
  }, [saving])

  async function create() {
    if (state.kind !== 'ready' || !title.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const pending = template.current
      if (!pending) throw new Error('The note template is unavailable.')
      const result = await pending
      if ('error' in result) throw result.error
      await createNote(state.vault, title.trim(), body, '', result.source)
      if (alive.current) close()
    } catch (cause) {
      if (!alive.current) return
      setError(message(cause))
      setSaving(false)
    }
  }

  const canCreate = state.kind === 'ready' && !!title.trim() && !saving

  if (!ready) return null

  return (
    <KeyboardAvoidingView style={s.root} behavior="padding">
      <View style={s.backdrop}>
        <View style={[s.card, { paddingBottom: insets.bottom + 12 }]}>
          <View style={s.toolbar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close quick note"
              disabled={saving}
              onPress={close}
              style={({ pressed }) => [s.close, pressed && s.pressed]}
            >
              <Text style={s.closeText}>Close</Text>
            </Pressable>
            <Text style={s.heading}>New note</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create note"
              disabled={!canCreate}
              onPress={() => void create()}
              style={({ pressed }) => [s.create, pressed && s.pressed, !canCreate && s.createOff]}
            >
              <Text style={[s.createText, !canCreate && s.createTextOff]}>
                {saving ? 'Creating…' : 'Create'}
              </Text>
            </Pressable>
          </View>

          {state.kind === 'loading' ? (
            <View style={s.center}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : state.kind === 'missing' || state.kind === 'error' ? (
            <View style={s.center}>
              <Text style={s.notice}>
                {state.kind === 'missing' ? 'Choose a notes folder in Typo first.' : state.message}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={close}
                style={({ pressed }) => [s.noticeButton, pressed && s.pressed]}
              >
                <Text style={s.noticeButtonText}>Close</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView
              style={s.flex}
              contentContainerStyle={s.form}
              keyboardShouldPersistTaps="handled"
            >
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
                onChangeText={(value) => {
                  setTitle(value)
                  setError(null)
                }}
                editable={!saving}
                autoFocus
                maxLength={180}
                cursorColor={colors.accent}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => bodyRef.current?.focus()}
                style={s.title}
              />
              <View style={s.divider} />
              <TextInput
                ref={bodyRef}
                accessibilityLabel="Note body"
                placeholder="Start anywhere. A sentence, a thought, a possibility…"
                placeholderTextColor={colors.muted}
                value={body}
                onChangeText={(value) => {
                  setBody(value)
                  setError(null)
                }}
                editable={!saving}
                multiline
                textAlignVertical="top"
                cursorColor={colors.accent}
                style={s.body}
              />
            </ScrollView>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not create the note.'
}

function useStyles() {
  const { colors } = useTheme()
  return StyleSheet.create({
    root: { flex: 1 },
    backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.45)' },
    card: {
      flex: 1,
      marginTop: 96,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      backgroundColor: colors.paper,
    },
    flex: { flex: 1 },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingTop: 16,
      paddingHorizontal: 16,
      paddingBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    heading: {
      flex: 1,
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 22,
      letterSpacing: -0.4,
      color: colors.ink,
      textAlign: 'center',
    },
    close: { minWidth: 64, height: 44, justifyContent: 'center' },
    closeText: { fontFamily: 'DMSans_600SemiBold', fontSize: 15, color: colors.muted },
    create: {
      minWidth: 96,
      height: 44,
      paddingHorizontal: 20,
      borderRadius: 22,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    createOff: { backgroundColor: colors.surface },
    createText: { fontFamily: 'DMSans_600SemiBold', fontSize: 16, color: colors.onAccent },
    createTextOff: { color: colors.muted },
    pressed: { opacity: 0.6 },
    form: { paddingTop: 24, paddingHorizontal: 20, paddingBottom: 40, flexGrow: 1 },
    errorInset: { paddingHorizontal: 4, marginBottom: 12 },
    title: {
      fontFamily: 'DMSans_600SemiBold',
      fontSize: 32,
      lineHeight: 38,
      letterSpacing: -0.8,
      color: colors.ink,
      padding: 0,
    },
    divider: { height: 1, backgroundColor: colors.line, marginVertical: 16 },
    body: {
      flex: 1,
      minHeight: 180,
      padding: 0,
      fontFamily: 'DMSans_400Regular',
      fontSize: 18,
      lineHeight: 27,
      color: colors.ink,
    },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 20 },
    notice: {
      fontFamily: 'DMSans_400Regular',
      fontSize: 16,
      lineHeight: 24,
      color: colors.muted,
      textAlign: 'center',
    },
    noticeButton: {
      height: 44,
      paddingHorizontal: 24,
      borderRadius: 22,
      backgroundColor: colors.soft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    noticeButtonText: { fontFamily: 'DMSans_600SemiBold', fontSize: 16, color: colors.ink },
  })
}
