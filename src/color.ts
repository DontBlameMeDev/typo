export type Rgb = { r: number; g: number; b: number }
export type Hsl = { h: number; s: number; l: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function parseHex(value: string): string | null {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : null
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (value: number) =>
    Math.round(clamp(value, 0, 255))
      .toString(16)
      .padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase()
}

export function hexToHsl(hex: string): Hsl {
  const { r, g, b } = hexToRgb(hex)
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  const l = (max + min) / 2
  if (delta === 0) return { h: 0, s: 0, l }
  const s = delta / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (max === red) h = 60 * (((green - blue) / delta) % 6)
  else if (max === green) h = 60 * ((blue - red) / delta + 2)
  else h = 60 * ((red - green) / delta + 4)
  return { h: (h + 360) % 360, s, l }
}

export function hslToHex({ h, s, l }: Hsl): string {
  const hue = ((h % 360) + 360) % 360
  const saturation = clamp(s, 0, 1)
  const lightness = clamp(l, 0, 1)
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const part = hue / 60
  const x = chroma * (1 - Math.abs((part % 2) - 1))
  const [red, green, blue] =
    part < 1
      ? [chroma, x, 0]
      : part < 2
        ? [x, chroma, 0]
        : part < 3
          ? [0, chroma, x]
          : part < 4
            ? [0, x, chroma]
            : part < 5
              ? [x, 0, chroma]
              : [chroma, 0, x]
  const m = lightness - chroma / 2
  return rgbToHex({ r: (red + m) * 255, g: (green + m) * 255, b: (blue + m) * 255 })
}

function channel(value: number): number {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
