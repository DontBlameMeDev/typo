import ArrowDown from 'lucide-react-native/icons/arrow-down'
import ArrowLeft from 'lucide-react-native/icons/arrow-left'
import ArrowLeftRight from 'lucide-react-native/icons/arrow-left-right'
import ArrowUp from 'lucide-react-native/icons/arrow-up'
import ArrowUpDown from 'lucide-react-native/icons/arrow-up-down'
import Bug from 'lucide-react-native/icons/bug'
import Check from 'lucide-react-native/icons/check'
import ChevronDown from 'lucide-react-native/icons/chevron-down'
import ChevronRight from 'lucide-react-native/icons/chevron-right'
import ChevronUp from 'lucide-react-native/icons/chevron-up'
import Circle from 'lucide-react-native/icons/circle'
import CircleAlert from 'lucide-react-native/icons/circle-alert'
import CircleCheck from 'lucide-react-native/icons/circle-check'
import CircleX from 'lucide-react-native/icons/circle-x'
import CodeXml from 'lucide-react-native/icons/code-xml'
import ExternalLink from 'lucide-react-native/icons/external-link'
import FileText from 'lucide-react-native/icons/file-text'
import FileWarning from 'lucide-react-native/icons/file-warning'
import Folder from 'lucide-react-native/icons/folder'
import FolderOpen from 'lucide-react-native/icons/folder-open'
import GitCommitHorizontal from 'lucide-react-native/icons/git-commit-horizontal'
import House from 'lucide-react-native/icons/house'
import Info from 'lucide-react-native/icons/info'
import ListFilter from 'lucide-react-native/icons/list-filter'
import Maximize from 'lucide-react-native/icons/maximize'
import Palette from 'lucide-react-native/icons/palette'
import Pencil from 'lucide-react-native/icons/pencil'
import Plus from 'lucide-react-native/icons/plus'
import Search from 'lucide-react-native/icons/search'
import Share2 from 'lucide-react-native/icons/share-2'
import Star from 'lucide-react-native/icons/star'
import Trash2 from 'lucide-react-native/icons/trash-2'
import X from 'lucide-react-native/icons/x'
import { View } from 'react-native'
import { useTheme } from './theme'

type OpenTrashProps = {
  size?: number
  color?: string
  fill?: string
  strokeWidth?: number
}

// Lucide has no open trash glyph. Its Trash2 is split into a lid and a can so
// the lid can tilt open without introducing a separate SVG path.
function OpenTrash({ size = 24, color = 'currentColor', strokeWidth = 2 }: OpenTrashProps) {
  const lid = Math.round(size * 0.28)
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: 'absolute',
          top: lid,
          left: 0,
          width: size,
          height: size - lid,
          overflow: 'hidden',
        }}
      >
        <View style={{ position: 'absolute', top: -lid, left: 0, width: size, height: size }}>
          <Trash2 size={size} color={color} strokeWidth={strokeWidth} />
        </View>
      </View>
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: lid,
          overflow: 'hidden',
          transformOrigin: '0% 100%',
          transform: [{ rotate: '-38deg' }],
        }}
      >
        <Trash2 size={size} color={color} strokeWidth={strokeWidth} />
      </View>
    </View>
  )
}

const icons = {
  search: Search,
  sort: ListFilter,
  swap: ArrowLeftRight,
  folder: Folder,
  folderOpen: FolderOpen,
  file: FileText,
  fileAlert: FileWarning,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  circle: Circle,
  arrowLeft: ArrowLeft,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  arrowUpDown: ArrowUpDown,
  palette: Palette,
  plus: Plus,
  close: X,
  closeCircle: CircleX,
  check: Check,
  checkCircle: CircleCheck,
  star: Star,
  trash: Trash2,
  trashOpen: OpenTrash,
  share: Share2,
  maximize: Maximize,
  edit: Pencil,
  home: House,
  alert: CircleAlert,
  info: Info,
  bug: Bug,
  commit: GitCommitHorizontal,
  external: ExternalLink,
  code: CodeXml,
} as const

export type IconName = keyof typeof icons

export function Icon({
  name,
  size = 22,
  color,
  fill,
  strokeWidth = 2,
}: {
  name: IconName
  size?: number
  color?: string
  fill?: string
  strokeWidth?: number
}) {
  const { colors } = useTheme()
  const Glyph = icons[name]
  return (
    <Glyph
      accessible={false}
      size={size}
      color={color ?? colors.ink}
      fill={fill ?? 'none'}
      strokeWidth={strokeWidth}
    />
  )
}
