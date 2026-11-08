import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  CodeXml,
  ExternalLink,
  FileText,
  FileWarning,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  House,
  Info,
  ListFilter,
  Maximize,
  Palette,
  Pencil,
  Plus,
  Search,
  Share2,
  Star,
  Trash2,
  Undo2,
  X,
} from 'lucide-react-native'
import { View } from 'react-native'
import { useTheme } from './theme'

type OpenTrashProps = {
  size?: number
  color?: string
  fill?: string
  strokeWidth?: number
  accessible?: boolean
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
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  arrowUpDown: ArrowUpDown,
  palette: Palette,
  plus: Plus,
  close: X,
  closeCircle: CircleX,
  check: Check,
  checkCircle: CircleCheck,
  circle: Circle,
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
  undo: Undo2,
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
