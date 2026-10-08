import { describe, expect, it } from 'vitest'
import { fontFamilyHasKnownLigatures, resolveTerminalLigaturesEnabled } from './terminal-ligatures'

describe('fontFamilyHasKnownLigatures', () => {
  it.each([
    'Fira Code',
    'FiraCode Nerd Font',
    'JetBrains Mono',
    'JetBrainsMono NF',
    'Cascadia Code',
    'CaskaydiaCove Nerd Font Mono',
    'Iosevka Term',
    'Monaspace Neon',
    '"Victor Mono", monospace'
  ])('recognises %s', (family) => {
    expect(fontFamilyHasKnownLigatures(family)).toBe(true)
  })

  it.each(['SF Mono', 'Menlo', 'Cascadia Mono', 'Fira Mono', 'Consolas', '', null, undefined])(
    'does not treat %s as a ligature font',
    (family) => {
      expect(fontFamilyHasKnownLigatures(family)).toBe(false)
    }
  )

  it('reads only the primary family of a stack', () => {
    expect(fontFamilyHasKnownLigatures('"SF Mono", "JetBrains Mono", monospace')).toBe(false)
  })
})

describe('resolveTerminalLigaturesEnabled', () => {
  it('lets explicit modes win over font detection', () => {
    expect(resolveTerminalLigaturesEnabled('on', 'Menlo')).toBe(true)
    expect(resolveTerminalLigaturesEnabled('off', 'Fira Code')).toBe(false)
  })

  it('follows the font in auto mode and for profiles without the setting', () => {
    expect(resolveTerminalLigaturesEnabled('auto', 'Fira Code')).toBe(true)
    expect(resolveTerminalLigaturesEnabled('auto', 'Cascadia Mono')).toBe(false)
    expect(resolveTerminalLigaturesEnabled(undefined, 'JetBrains Mono')).toBe(true)
    expect(resolveTerminalLigaturesEnabled(null, 'SF Mono')).toBe(false)
  })
})
