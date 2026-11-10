import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Icon } from './icons'
import { useTheme } from './theme'

export function ErrorBanner({
  message,
  title,
  onDismiss,
}: {
  message: string
  title?: string
  onDismiss?: () => void
}) {
  const { colors } = useTheme()
  const s = styles(colors)
  return (
    <View accessibilityLiveRegion="polite" style={s.banner}>
      <Icon name="alert" color={colors.coral} />
      <View style={s.body}>
        {title && <Text style={s.title}>{title}</Text>}
        <ScrollView style={s.details} nestedScrollEnabled>
          <Text selectable style={s.message}>
            {message}
          </Text>
        </ScrollView>
      </View>
      {onDismiss && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss error"
          onPress={onDismiss}
          style={({ pressed }) => [s.dismiss, pressed && s.pressed]}
        >
          <Icon name="close" />
        </Pressable>
      )}
    </View>
  )
}

function styles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    banner: {
      backgroundColor: colors.coralSoft,
      borderRadius: 14,
      padding: 13,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
    },
    body: { flex: 1 },
    title: {
      color: colors.ink,
      fontSize: 15,
      lineHeight: 22,
      fontFamily: 'DMSans_600SemiBold',
      marginBottom: 6,
    },
    details: { maxHeight: 180 },
    message: {
      flex: 1,
      color: colors.ink,
      fontSize: 14,
      lineHeight: 20,
      fontFamily: 'DMSans_400Regular',
    },
    dismiss: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 14,
    },
    pressed: { opacity: 0.66 },
  })
}
