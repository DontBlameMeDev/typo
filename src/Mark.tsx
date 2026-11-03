import Svg, { Path } from 'react-native-svg'
import { useTheme } from './theme'

export function TypoMark({ size }: { size: number }) {
  const { colors, palette } = useTheme()
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <Path
        d="M280 160H664L800 296V808Q800 864 744 864H280Q224 864 224 808V216Q224 160 280 160Z"
        fill={colors.accent}
      />
      <Path d="M664 160L800 296H664Z" fill={palette.rosewater} />
      <Path
        d="M512 286V640Q512 724 596 724H648"
        fill="none"
        stroke={colors.onAccent}
        strokeWidth={140}
        strokeLinecap="round"
      />
      <Path
        d="M356 400H668"
        fill="none"
        stroke={colors.onAccent}
        strokeWidth={140}
        strokeLinecap="round"
      />
    </Svg>
  )
}
