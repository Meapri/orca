// Font families that ship with programming-ligatures out of the box. Used by
// the `'auto'` mode of `terminalLigatures` so users who pick a ligature font
// get the feature for free without touching settings. Matching ignores case,
// spaces and hyphens and is substring-based, so Nerd Font renames such as
// "FiraCode Nerd Font" or "JetBrainsMono NF" still resolve. Fira Mono and
// Cascadia Mono are the ligature-free cuts of Fira Code and Cascadia Code.
const LIGATURE_FONT_TOKENS = [
  'firacode',
  'jetbrainsmono',
  'cascadiacode',
  'caskaydiacove',
  'iosevka',
  'victormono',
  'hasklig',
  'hasklug',
  'monoid',
  'operatormono',
  'dankmono',
  'mononoki',
  'pragmatapro',
  'recursive',
  'monolisa',
  'commitmono',
  'geistmono',
  'maplemono',
  'departuremono',
  'monaspace',
  'lilex'
] as const

function normalizeFontName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '')
}

/** Whether a user-facing font-family string looks like one of the well-known
 *  ligature-capable programming fonts. Matches the first declared family in
 *  the string (the user's choice) rather than any fallback. */
export function fontFamilyHasKnownLigatures(fontFamily: string | null | undefined): boolean {
  if (!fontFamily) {
    return false
  }
  // `terminalFontFamily` is a single family name in settings, but
  // defensively split on commas so the helper also works when fed a full
  // `font-family` stack (e.g. via `buildFontFamily`).
  const primary = normalizeFontName(fontFamily.split(',')[0]?.replace(/["']/g, '') ?? '')
  if (!primary) {
    return false
  }
  return LIGATURE_FONT_TOKENS.some((token) => primary.includes(token))
}

/** Resolve the effective ligature-enabled state from the user setting and
 *  the current font. `'auto'` defers to font detection; explicit `'on'` /
 *  `'off'` always wins so a user who disables ligatures keeps them disabled
 *  even after switching to Fira Code. */
export function resolveTerminalLigaturesEnabled(
  mode: 'auto' | 'on' | 'off' | null | undefined,
  fontFamily: string | null | undefined
): boolean {
  if (mode === 'on') {
    return true
  }
  if (mode === 'off') {
    return false
  }
  return fontFamilyHasKnownLigatures(fontFamily)
}
