import { describe, expect, it } from 'vitest'
import {
  buildCjkFallbackFonts,
  buildFontFamily,
  parseFontFamilyList,
  resolvePreferredCjkScript
} from './monospace-font-family'

const LATIN_AND_SYMBOLS =
  '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font"'
const MAC_EN_CJK =
  '"PingFang SC", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang TC", "PingFang HK", "Apple SD Gothic Neo"'
const FULL_FALLBACK = `${LATIN_AND_SYMBOLS}, ${MAC_EN_CJK}, monospace`
const MAC_EN = { platform: 'darwin', locales: ['en-US'] } as const

describe('buildFontFamily', () => {
  it('puts custom font first with full cross-platform fallback chain', () => {
    expect(buildFontFamily('JetBrains Mono', MAC_EN)).toBe(`"JetBrains Mono", ${FULL_FALLBACK}`)
  })

  it('does not duplicate SF Mono when it is the input', () => {
    expect(buildFontFamily('SF Mono', MAC_EN)).toBe(FULL_FALLBACK)
  })

  it('returns full fallback chain for empty string', () => {
    expect(buildFontFamily('', MAC_EN)).toBe(FULL_FALLBACK)
  })

  it('treats whitespace-only string same as empty', () => {
    expect(buildFontFamily('   ', MAC_EN)).toBe(FULL_FALLBACK)
  })

  it('does not duplicate when font name contains "sf mono" (case-insensitive)', () => {
    expect(buildFontFamily('My SF Mono Custom', MAC_EN)).toBe(
      `"My SF Mono Custom", ${FULL_FALLBACK.replace('"SF Mono", ', '')}`
    )
  })

  it('does not duplicate Consolas when it is the input', () => {
    expect(buildFontFamily('Consolas', MAC_EN)).toBe(
      `"Consolas", ${FULL_FALLBACK.replace('"Consolas", ', '')}`
    )
  })

  it('does not duplicate the bundled Nerd Font symbol fallback', () => {
    expect(buildFontFamily('Orca Nerd Font Symbols', MAC_EN)).toBe(
      `"Orca Nerd Font Symbols", ${FULL_FALLBACK.replace('"Orca Nerd Font Symbols", ', '')}`
    )
  })

  it('keeps every Latin and symbol font ahead of the CJK faces', () => {
    const chain = buildFontFamily('', { platform: 'win32', locales: ['ko-KR'] })
    expect(chain.indexOf('"Hack Nerd Font"')).toBeLessThan(chain.indexOf('"Malgun Gothic"'))
    expect(
      chain.endsWith(
        '"Malgun Gothic", "Microsoft YaHei", "Yu Gothic", "Meiryo", "Microsoft JhengHei", monospace'
      )
    ).toBe(true)
  })

  it('never lists another platform’s CJK faces', () => {
    const chain = buildFontFamily('', { platform: 'darwin', locales: ['ko'] })
    expect(chain).not.toContain('Malgun Gothic')
    expect(chain).not.toContain('Noto Sans')
  })

  it('inserts the user fallback stack right after the primary font', () => {
    const chain = buildFontFamily('Fira Code', {
      ...MAC_EN,
      fallbackFamilies: 'D2Coding, "Noto Color Emoji"'
    })
    expect(chain.startsWith('"Fira Code", "D2Coding", "Noto Color Emoji", "SF Mono"')).toBe(true)
  })

  it('lets a user fallback override a built-in CJK face without duplicating it', () => {
    const chain = buildFontFamily('', { ...MAC_EN, fallbackFamilies: 'Apple SD Gothic Neo' })
    expect(chain.startsWith('"Apple SD Gothic Neo", "SF Mono"')).toBe(true)
    expect(chain.match(/Apple SD Gothic Neo/g)).toHaveLength(1)
  })

  it('keeps generic families unquoted and strips characters that would break the CSS string', () => {
    const chain = buildFontFamily('', { ...MAC_EN, fallbackFamilies: 'emoji, Bad"Font\\' })
    expect(chain.startsWith('emoji, "BadFont", "SF Mono"')).toBe(true)
  })

  it('ignores an empty or comma-only fallback stack', () => {
    expect(buildFontFamily('', { ...MAC_EN, fallbackFamilies: ' , ,' })).toBe(FULL_FALLBACK)
  })
})

describe('resolvePreferredCjkScript', () => {
  it.each([
    [['ko-KR', 'en-US'], 'ko'],
    [['en-US', 'ja-JP'], 'ja'],
    [['zh-CN'], 'zh-Hans'],
    [['zh'], 'zh-Hans'],
    [['zh-Hans-SG'], 'zh-Hans'],
    [['zh-TW'], 'zh-Hant'],
    [['zh-HK'], 'zh-Hant'],
    [['zh-Hant-MO'], 'zh-Hant']
  ] as const)('maps %j to %s', (locales, script) => {
    expect(resolvePreferredCjkScript(locales)).toBe(script)
  })

  it('returns null without a CJK language', () => {
    expect(resolvePreferredCjkScript(['en-US', 'fr', 'kok'])).toBeNull()
  })
})

describe('buildCjkFallbackFonts', () => {
  it('orders Korean faces first for a Korean locale', () => {
    expect(buildCjkFallbackFonts('linux', ['ko-KR'])[0]).toBe('Noto Sans Mono CJK KR')
    expect(buildCjkFallbackFonts('darwin', ['ko-KR'])[0]).toBe('Apple SD Gothic Neo')
  })

  it('orders Traditional Chinese faces first for zh-TW', () => {
    expect(buildCjkFallbackFonts('darwin', ['zh-TW'])[0]).toBe('PingFang TC')
  })

  it('falls back to the Linux list for other Unix platforms', () => {
    expect(buildCjkFallbackFonts('freebsd', ['ja'])[0]).toBe('Noto Sans Mono CJK JP')
  })
})

describe('parseFontFamilyList', () => {
  it('splits, trims and unquotes a CSS stack', () => {
    expect(parseFontFamilyList(` "A B", 'C' ,D,, `)).toEqual(['A B', 'C', 'D'])
  })

  it('returns an empty list for undefined', () => {
    expect(parseFontFamilyList(undefined)).toEqual([])
  })
})
