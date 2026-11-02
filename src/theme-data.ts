export const accentNames = [
  'rosewater',
  'flamingo',
  'pink',
  'mauve',
  'red',
  'maroon',
  'peach',
  'yellow',
  'green',
  'teal',
  'sky',
  'sapphire',
  'blue',
  'lavender',
] as const
export type Accent = (typeof accentNames)[number]
export const flavorNames = ['latte', 'frappe', 'macchiato', 'mocha'] as const
export type Flavor = (typeof flavorNames)[number]
export const lightFlavorNames = ['latte'] as const
export type LightFlavor = (typeof lightFlavorNames)[number]
export const darkFlavorNames = ['frappe', 'macchiato', 'mocha'] as const
export type DarkFlavor = (typeof darkFlavorNames)[number]
export type AppearanceMode = 'system' | 'light' | 'dark'
export type ThemeSettings = {
  mode: AppearanceMode
  lightFlavor: Flavor
  darkFlavor: Flavor
  accent: Accent
  amoled: boolean
}

type Palette = Record<
  | Accent
  | 'text'
  | 'subtext1'
  | 'subtext0'
  | 'overlay2'
  | 'overlay1'
  | 'overlay0'
  | 'surface2'
  | 'surface1'
  | 'surface0'
  | 'base'
  | 'mantle'
  | 'crust',
  string
>

export const palettes: Record<Flavor, Palette> = {
  latte: {
    rosewater: '#dc8a78',
    flamingo: '#dd7878',
    pink: '#ea76cb',
    mauve: '#8839ef',
    red: '#d20f39',
    maroon: '#e64553',
    peach: '#fe640b',
    yellow: '#df8e1d',
    green: '#40a02b',
    teal: '#179299',
    sky: '#04a5e5',
    sapphire: '#209fb5',
    blue: '#1e66f5',
    lavender: '#7287fd',
    text: '#4c4f69',
    subtext1: '#5c5f77',
    subtext0: '#6c6f85',
    overlay2: '#7c7f93',
    overlay1: '#8c8fa1',
    overlay0: '#9ca0b0',
    surface2: '#acb0be',
    surface1: '#bcc0cc',
    surface0: '#ccd0da',
    base: '#eff1f5',
    mantle: '#e6e9ef',
    crust: '#dce0e8',
  },
  frappe: {
    rosewater: '#f2d5cf',
    flamingo: '#eebebe',
    pink: '#f4b8e4',
    mauve: '#ca9ee6',
    red: '#e78284',
    maroon: '#ea999c',
    peach: '#ef9f76',
    yellow: '#e5c890',
    green: '#a6d189',
    teal: '#81c8be',
    sky: '#99d1db',
    sapphire: '#85c1dc',
    blue: '#8caaee',
    lavender: '#babbf1',
    text: '#c6d0f5',
    subtext1: '#b5bfe2',
    subtext0: '#a5adce',
    overlay2: '#949cbb',
    overlay1: '#838ba7',
    overlay0: '#737994',
    surface2: '#626880',
    surface1: '#51576d',
    surface0: '#414559',
    base: '#303446',
    mantle: '#292c3c',
    crust: '#232634',
  },
  macchiato: {
    rosewater: '#f4dbd6',
    flamingo: '#f0c6c6',
    pink: '#f5bde6',
    mauve: '#c6a0f6',
    red: '#ed8796',
    maroon: '#ee99a0',
    peach: '#f5a97f',
    yellow: '#eed49f',
    green: '#a6da95',
    teal: '#8bd5ca',
    sky: '#91d7e3',
    sapphire: '#7dc4e4',
    blue: '#8aadf4',
    lavender: '#b7bdf8',
    text: '#cad3f5',
    subtext1: '#b8c0e0',
    subtext0: '#a5adcb',
    overlay2: '#939ab7',
    overlay1: '#8087a2',
    overlay0: '#6e738d',
    surface2: '#5b6078',
    surface1: '#494d64',
    surface0: '#363a4f',
    base: '#24273a',
    mantle: '#1e2030',
    crust: '#181926',
  },
  mocha: {
    rosewater: '#f5e0dc',
    flamingo: '#f2cdcd',
    pink: '#f5c2e7',
    mauve: '#cba6f7',
    red: '#f38ba8',
    maroon: '#eba0ac',
    peach: '#fab387',
    yellow: '#f9e2af',
    green: '#a6e3a1',
    teal: '#94e2d5',
    sky: '#89dceb',
    sapphire: '#74c7ec',
    blue: '#89b4fa',
    lavender: '#b4befe',
    text: '#cdd6f4',
    subtext1: '#bac2de',
    subtext0: '#a6adc8',
    overlay2: '#9399b2',
    overlay1: '#7f849c',
    overlay0: '#6c7086',
    surface2: '#585b70',
    surface1: '#45475a',
    surface0: '#313244',
    base: '#1e1e2e',
    mantle: '#181825',
    crust: '#11111b',
  },
}

export const defaultThemeSettings: ThemeSettings = {
  mode: 'system',
  lightFlavor: 'latte',
  darkFlavor: 'mocha',
  accent: 'mauve',
  amoled: false,
}

function normalizeLightFlavor(value: unknown): LightFlavor {
  return lightFlavorNames.includes(value as LightFlavor) ? (value as LightFlavor) : 'latte'
}

function normalizeDarkFlavor(value: unknown): DarkFlavor {
  return darkFlavorNames.includes(value as DarkFlavor) ? (value as DarkFlavor) : 'mocha'
}

export function parseThemeSettings(value: unknown): ThemeSettings {
  const result = { ...defaultThemeSettings }
  if (!value || typeof value !== 'object') return result
  const candidate = value as Record<string, unknown>
  if (['system', 'light', 'dark'].includes(candidate.mode as string))
    result.mode = candidate.mode as AppearanceMode
  result.lightFlavor = normalizeLightFlavor(candidate.lightFlavor)
  result.darkFlavor = normalizeDarkFlavor(candidate.darkFlavor)
  if (accentNames.includes(candidate.accent as Accent)) result.accent = candidate.accent as Accent
  if (typeof candidate.amoled === 'boolean') result.amoled = candidate.amoled
  return result
}

export function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

export function resolveTheme(settings: ThemeSettings, systemDark: boolean) {
  const darkSlot = settings.mode === 'dark' || (settings.mode === 'system' && systemDark)
  const flavor = darkSlot
    ? normalizeDarkFlavor(settings.darkFlavor)
    : normalizeLightFlavor(settings.lightFlavor)
  const palette = palettes[flavor]
  const isDark = flavor !== 'latte'
  const accent = palette[settings.accent]
  const colors = {
    paper: isDark && settings.amoled ? '#000000' : palette.base,
    ink: palette.text,
    muted: palette.subtext1,
    line: palette.surface0,
    sage: accent,
    accent,
    onAccent: luminance(accent) > 0.179 ? '#000000' : '#ffffff',
    soft: isDark && settings.amoled ? palette.crust : palette.mantle,
    white: isDark && settings.amoled ? palette.mantle : palette.base,
    coral: palette.red,
    coralSoft: palette.surface0,
  }
  return { colors, isDark, flavor, palette }
}

export type ThemeColors = ReturnType<typeof resolveTheme>['colors']
