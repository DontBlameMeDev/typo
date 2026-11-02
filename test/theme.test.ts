import { describe, expect, test } from 'bun:test'
import {
  accentNames,
  darkFlavorNames,
  defaultThemeSettings,
  flavorNames,
  lightFlavorNames,
  luminance,
  palettes,
  parseThemeSettings,
  resolveTheme,
} from '../src/theme-data'

const hex = /^#[0-9a-f]{6}$/iu
const colorKeys = [
  'paper',
  'ink',
  'muted',
  'line',
  'sage',
  'accent',
  'onAccent',
  'soft',
  'white',
  'coral',
  'coralSoft',
] as const

describe('Catppuccin palettes', () => {
  test('include all four flavors and all fourteen accents', () => {
    expect(flavorNames).toEqual(['latte', 'frappe', 'macchiato', 'mocha'])
    expect(lightFlavorNames).toEqual(['latte'])
    expect(darkFlavorNames).toEqual(['frappe', 'macchiato', 'mocha'])
    expect(accentNames).toHaveLength(14)
    for (const flavor of flavorNames) {
      expect(Object.keys(palettes[flavor])).toEqual(
        expect.arrayContaining([
          ...accentNames,
          'text',
          'subtext1',
          'subtext0',
          'overlay2',
          'overlay1',
          'overlay0',
          'surface2',
          'surface1',
          'surface0',
          'base',
          'mantle',
          'crust',
        ])
      )
      for (const value of Object.values(palettes[flavor])) expect(value).toMatch(hex)
    }
  })

  test('uses the official flavor base colors', () => {
    expect(palettes.latte.base).toBe('#eff1f5')
    expect(palettes.frappe.base).toBe('#303446')
    expect(palettes.macchiato.base).toBe('#24273a')
    expect(palettes.mocha.base).toBe('#1e1e2e')
  })
})

describe('theme settings', () => {
  test('default to Latte Mauve and Mocha Mauve', () => {
    expect(defaultThemeSettings).toEqual({
      mode: 'system',
      lightFlavor: 'latte',
      darkFlavor: 'mocha',
      accent: 'mauve',
      amoled: false,
    })
  })

  test('parse valid partial settings and ignore invalid values', () => {
    expect(
      parseThemeSettings({
        mode: 'light',
        lightFlavor: 'latte',
        darkFlavor: 'macchiato',
        accent: 'teal',
        amoled: true,
      })
    ).toEqual({
      mode: 'light',
      lightFlavor: 'latte',
      darkFlavor: 'macchiato',
      accent: 'teal',
      amoled: true,
    })
    expect(
      parseThemeSettings({
        mode: 'sepia',
        lightFlavor: 'mocha',
        darkFlavor: 'unknown',
        accent: 'orange',
        amoled: 'yes',
      })
    ).toEqual({
      mode: 'system',
      lightFlavor: 'latte',
      darkFlavor: 'mocha',
      accent: 'mauve',
      amoled: false,
    })
    expect(parseThemeSettings(null)).toEqual(defaultThemeSettings)
    expect(parseThemeSettings('mocha')).toEqual(defaultThemeSettings)
  })

  test('migrate persisted palettes that are invalid for their slot', () => {
    expect(
      parseThemeSettings({
        lightFlavor: 'frappe',
        darkFlavor: 'latte',
      })
    ).toEqual({
      ...defaultThemeSettings,
      lightFlavor: 'latte',
      darkFlavor: 'mocha',
    })
    for (const flavor of darkFlavorNames) {
      expect(parseThemeSettings({ darkFlavor: flavor }).darkFlavor).toBe(flavor)
    }
  })
})

describe('resolved theme', () => {
  test('follows the system appearance by default', () => {
    const light = resolveTheme(defaultThemeSettings, false)
    expect(light.isDark).toBe(false)
    expect(light.flavor).toBe('latte')
    expect(light.colors.accent).toBe(palettes.latte.mauve)

    const dark = resolveTheme(defaultThemeSettings, true)
    expect(dark.isDark).toBe(true)
    expect(dark.flavor).toBe('mocha')
    expect(dark.colors.accent).toBe(palettes.mocha.mauve)
  })

  test('honors explicit light and dark modes', () => {
    const light = resolveTheme({ ...defaultThemeSettings, mode: 'light' }, true)
    expect(light.flavor).toBe('latte')
    expect(light.isDark).toBe(false)

    const dark = resolveTheme({ ...defaultThemeSettings, mode: 'dark' }, false)
    expect(dark.flavor).toBe('mocha')
    expect(dark.isDark).toBe(true)
  })

  test('keeps every required color key and maps sage to accent', () => {
    for (const flavor of darkFlavorNames) {
      const theme = resolveTheme(
        { ...defaultThemeSettings, mode: 'dark', darkFlavor: flavor },
        false
      )
      for (const key of colorKeys) expect(theme.colors[key]).toMatch(hex)
      expect(theme.colors.sage).toBe(theme.colors.accent)
      expect(['#000000', '#ffffff']).toContain(theme.colors.onAccent)
    }
  })

  test('never resolves a dark palette for light or Latte for dark', () => {
    const light = resolveTheme({ ...defaultThemeSettings, lightFlavor: 'mocha' }, false)
    expect(light.flavor).toBe('latte')
    expect(light.isDark).toBe(false)

    for (const flavor of darkFlavorNames) {
      const dark = resolveTheme(
        { ...defaultThemeSettings, mode: 'dark', darkFlavor: flavor },
        false
      )
      expect(dark.flavor).toBe(flavor)
      expect(dark.isDark).toBe(true)
    }

    const latteDark = resolveTheme(
      { ...defaultThemeSettings, mode: 'dark', darkFlavor: 'latte' },
      false
    )
    expect(latteDark.flavor).toBe(defaultThemeSettings.darkFlavor)
    expect(latteDark.isDark).toBe(true)
  })

  test('uses pure black for AMOLED dark mode only', () => {
    const amoled = resolveTheme({ ...defaultThemeSettings, mode: 'dark', amoled: true }, false)
    expect(amoled.colors.paper).toBe('#000000')
    expect(amoled.colors.soft).toBe(palettes.mocha.crust)

    const light = resolveTheme({ ...defaultThemeSettings, mode: 'light', amoled: true }, false)
    expect(light.colors.paper).toBe(palettes.latte.base)
  })

  test('picks a readable onAccent color for every accent', () => {
    for (const accent of accentNames) {
      const { colors } = resolveTheme({ ...defaultThemeSettings, accent }, false)
      expect(colors.onAccent).toBe(luminance(colors.accent) > 0.179 ? '#000000' : '#ffffff')
    }
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1)
  })
})
