import { useEffect, useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Reanimated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Circle, Path } from 'react-native-svg'
import { Icon } from './icons'
import { TypoMark } from './Mark'
import { ReportIssue } from './ReportIssue'
import { type ThemeColors, useTheme } from './theme'
import type { VaultScanProgress } from './vault'

const BIG_RADIUS = 52
const BIG_STROKE = 8
const SMALL_RADIUS = 11
const SMALL_STROKE = 3.5
const FULL = 2 * Math.PI

function useRotation(active: boolean) {
  const spin = useSharedValue(0)
  useEffect(() => {
    if (!active) {
      spin.value = 0
      return
    }
    spin.value = 0
    spin.value = withRepeat(
      withTiming(360, { duration: 900, easing: Easing.linear, reduceMotion: ReduceMotion.System }),
      -1
    )
  }, [active, spin])
  return useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value}deg` }] }))
}

function Arc({
  size,
  radius,
  stroke,
  fraction,
  colors,
}: {
  size: number
  radius: number
  stroke: number
  fraction: number
  colors: ThemeColors
}) {
  const length = FULL * radius
  const center = size / 2
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={colors.line}
        strokeWidth={stroke}
      />
      <Circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={colors.accent}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${length * fraction} ${length}`}
        transform={`rotate(-90 ${center} ${center})`}
      />
    </Svg>
  )
}

function Spinner({ colors }: { colors: ThemeColors }) {
  const rotation = useRotation(true)
  return (
    <Reanimated.View style={[{ width: 30, height: 30 }, rotation]}>
      <Arc size={30} radius={SMALL_RADIUS} stroke={SMALL_STROKE} fraction={0.25} colors={colors} />
    </Reanimated.View>
  )
}

function Done({ colors }: { colors: ThemeColors }) {
  return (
    <View style={[styles.done, { backgroundColor: colors.accent }]}>
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" fill={colors.onAccent} />
      </Svg>
    </View>
  )
}

function count(value: number, word: string) {
  return `${value} ${word}${value === 1 ? '' : 's'}`
}

export function VaultSetup({
  progress,
  done,
  onDone,
}: {
  progress: VaultScanProgress
  done: boolean
  onDone: () => void
}) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const rotation = useRotation(progress.stage === 'folders' && !done)
  const fraction = done
    ? 1
    : progress.stage === 'notes'
      ? progress.notes > 0
        ? progress.done / progress.notes
        : 0
      : 0.25
  const fill = useSharedValue(0)
  const mark = useSharedValue(1)
  const check = useSharedValue(0)
  const screen = useSharedValue(1)
  useEffect(() => {
    if (!done) return
    fill.value = withTiming(1, {
      duration: 320,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    })
    mark.value = withTiming(0, { duration: 180, reduceMotion: ReduceMotion.System })
    check.value = withDelay(
      140,
      withSpring(1, { damping: 15, stiffness: 220, mass: 0.6, reduceMotion: ReduceMotion.System })
    )
    screen.value = withDelay(
      650,
      withTiming(
        0,
        { duration: 1000, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.System },
        (finished) => {
          if (finished) runOnJS(onDone)()
        }
      )
    )
  }, [check, done, fill, mark, onDone, screen])
  const discStyle = useAnimatedStyle(() => ({
    opacity: fill.value,
    transform: [{ scale: 0.7 + fill.value * 0.3 }],
  }))
  const markStyle = useAnimatedStyle(() => ({
    opacity: mark.value,
    transform: [{ scale: 0.8 + mark.value * 0.2 }],
  }))
  const checkStyle = useAnimatedStyle(() => ({
    opacity: check.value,
    transform: [{ scale: 0.6 + check.value * 0.4 }],
  }))
  const screenStyle = useAnimatedStyle(() => ({ opacity: screen.value }))
  const local = useMemo(
    () =>
      StyleSheet.create({
        card: { backgroundColor: colors.soft, borderRadius: 24, marginTop: 28 },
        divider: { backgroundColor: colors.line, height: 1, marginHorizontal: 14 },
        title: { color: colors.ink },
        body: { color: colors.muted },
        bar: { backgroundColor: colors.line },
        fill: { backgroundColor: colors.accent },
        disc: { backgroundColor: colors.accent },
        overlay: { backgroundColor: colors.paper },
      }),
    [colors]
  )
  return (
    <Reanimated.View
      accessibilityViewIsModal
      style={[
        styles.overlay,
        local.overlay,
        screenStyle,
        {
          paddingTop: insets.top,
          paddingRight: insets.right,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
        },
      ]}
    >
      <View style={styles.wrap}>
        <View style={styles.content}>
          <View style={styles.ring}>
            <Reanimated.View style={[StyleSheet.absoluteFill, rotation]}>
              <Arc
                size={120}
                radius={BIG_RADIUS}
                stroke={BIG_STROKE}
                fraction={fraction}
                colors={colors}
              />
            </Reanimated.View>
            <Reanimated.View style={[styles.disc, local.disc, discStyle]} />
            <View style={styles.mark}>
              <Reanimated.View style={markStyle}>
                <TypoMark size={52} />
              </Reanimated.View>
              <Reanimated.View style={[styles.checkMark, checkStyle]}>
                <Svg width={56} height={56} viewBox="0 0 24 24">
                  <Path
                    d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"
                    fill={colors.paper}
                  />
                </Svg>
              </Reanimated.View>
            </View>
          </View>
          <Text style={[styles.heading, local.title]}>Setting up your notes</Text>
          <View style={local.card}>
            <View style={styles.row}>
              {progress.stage === 'folders' && !done ? (
                <Spinner colors={colors} />
              ) : (
                <Done colors={colors} />
              )}
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, local.title]}>
                  {progress.stage === 'folders' && !done
                    ? 'Looking through your folders'
                    : 'Found your folder'}
                </Text>
                <Text style={[styles.rowBody, local.body]}>
                  {`${count(progress.notes, 'note')} in ${count(progress.folders, 'folder')}`}
                </Text>
              </View>
            </View>
            {progress.stage === 'notes' && (
              <>
                <View style={local.divider} />
                <View style={styles.row}>
                  {done ? <Done colors={colors} /> : <Spinner colors={colors} />}
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, local.title]}>Indexing note contents</Text>
                    <Text style={[styles.rowBody, local.body]}>
                      {done ? progress.notes : progress.done} of {progress.notes}
                    </Text>
                  </View>
                </View>
                <View style={styles.progress}>
                  <View style={[styles.bar, local.bar]}>
                    <View
                      style={[
                        styles.fill,
                        local.fill,
                        { width: `${(done ? 1 : fraction) * 100}%` },
                      ]}
                    />
                  </View>
                  {progress.path ? (
                    <View style={styles.pathRow}>
                      <Icon name="file" size={16} color={colors.muted} />
                      <Text numberOfLines={1} style={[styles.path, local.body]}>
                        {progress.path}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </>
            )}
          </View>
        </View>
        <View style={styles.report}>
          <ReportIssue />
        </View>
      </View>
    </Reanimated.View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 20,
    elevation: 20,
  },
  wrap: { flex: 1, paddingBottom: 32 },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  ring: { width: 120, height: 120, alignSelf: 'center' },
  disc: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 60 },
  mark: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMark: { position: 'absolute', top: 32, left: 32 },
  heading: {
    fontFamily: 'DMSans_600SemiBold',
    fontSize: 28,
    letterSpacing: -0.7,
    marginTop: 22,
    textAlign: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontFamily: 'DMSans_600SemiBold', fontSize: 17 },
  rowBody: { fontFamily: 'DMSans_400Regular', fontSize: 13, marginTop: 1 },
  done: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  progress: { marginTop: 12, marginLeft: 44, marginBottom: 14 },
  bar: { height: 6, borderRadius: 3 },
  fill: { height: 6, borderRadius: 3 },
  pathRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  path: { flex: 1, minWidth: 0, fontFamily: 'JetBrainsMono_400Regular', fontSize: 12 },
  report: { paddingHorizontal: 24 },
})
