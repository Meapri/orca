import type { IUnicodeHandling, IUnicodeVersionProvider } from '@xterm/xterm'
import {
  isCodepointInRanges,
  POST_UNICODE11_WIDE_EMOJI_RANGES,
  TEXT_DEFAULT_EMOJI_RANGES
} from './terminal-emoji-width-ranges'

type XtermTerminalWithUnicodeCore = {
  unicode: IUnicodeHandling
  _core?: {
    unicodeService?: {
      _providers?: Record<string, IUnicodeVersionProvider>
    }
  }
}

const ORCA_UNICODE_VERSION = 'orca-11-zwj'
const UNICODE11_VERSION = '11'
const ZERO_WIDTH_JOINER = 0x200d
const VARIATION_SELECTOR_16 = 0xfe0f

function extractWidth(properties: number): 0 | 1 | 2 {
  return ((properties >> 1) & 3) as 0 | 1 | 2
}

function extractCharKind(properties: number): number {
  return properties >> 3
}

function createProperties(charKind: number, width: 0 | 1 | 2, shouldJoin: boolean): number {
  return ((charKind & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0)
}

function isTextDefaultEmoji(codepoint: number): boolean {
  if (codepoint < 0x80) {
    return codepoint === 0x23 || codepoint === 0x2a || (codepoint >= 0x30 && codepoint <= 0x39)
  }
  // Why: CJK and most BMP text sit between the two table clusters; skip the search for them.
  if (codepoint < 0xa9 || (codepoint > 0x2b07 && codepoint < 0x1f170) || codepoint > 0x1f6f3) {
    return false
  }
  return isCodepointInRanges(codepoint, TEXT_DEFAULT_EMOJI_RANGES)
}

function isPostUnicode11WideEmoji(codepoint: number): boolean {
  return (
    codepoint >= 0x1f6d6 &&
    codepoint <= 0x1faf8 &&
    isCodepointInRanges(codepoint, POST_UNICODE11_WIDE_EMOJI_RANGES)
  )
}

class OrcaUnicodeProvider implements IUnicodeVersionProvider {
  public readonly version = ORCA_UNICODE_VERSION

  public constructor(private readonly baseProvider: IUnicodeVersionProvider) {}

  public wcwidth(codepoint: number): 0 | 1 | 2 {
    return isPostUnicode11WideEmoji(codepoint) ? 2 : this.baseProvider.wcwidth(codepoint)
  }

  public charProperties(codepoint: number, preceding: number): number {
    const precedingWidth = extractWidth(preceding)
    const precedingKind = extractCharKind(preceding)

    if (codepoint === ZERO_WIDTH_JOINER && precedingWidth > 0) {
      return createProperties(ZERO_WIDTH_JOINER, precedingWidth, true)
    }

    if (precedingKind === ZERO_WIDTH_JOINER && precedingWidth > 0 && this.wcwidth(codepoint) > 0) {
      // Why: CLIs render ZWJ emoji as one visible glyph and budget them as one
      // wide cell pair; xterm Unicode11 otherwise advances for both emoji parts.
      return createProperties(codepoint, precedingWidth, true)
    }

    if (
      codepoint === VARIATION_SELECTOR_16 &&
      precedingWidth === 1 &&
      isTextDefaultEmoji(precedingKind)
    ) {
      // Why: VS16 selects emoji presentation (❤️, 1️⃣), which modern CLIs and
      // terminals budget as two cells; xterm keeps the one-cell text width.
      return createProperties(VARIATION_SELECTOR_16, 2, true)
    }

    if (isPostUnicode11WideEmoji(codepoint)) {
      return createProperties(0, 2, false)
    }

    const properties = this.baseProvider.charProperties(codepoint, preceding)
    if (extractWidth(properties) === 1 && isTextDefaultEmoji(codepoint)) {
      // Why: remember the base so a following VS16 can widen it; width and join are unchanged.
      return createProperties(codepoint, 1, (properties & 1) !== 0)
    }
    return properties
  }
}

export function activateOrcaTerminalUnicodeProvider(terminal: XtermTerminalWithUnicodeCore): void {
  const { unicode } = terminal
  if (unicode.activeVersion === ORCA_UNICODE_VERSION) {
    return
  }

  const baseProvider = terminal._core?.unicodeService?._providers?.[UNICODE11_VERSION]
  if (!baseProvider) {
    unicode.activeVersion = UNICODE11_VERSION
    return
  }

  if (!unicode.versions.includes(ORCA_UNICODE_VERSION)) {
    unicode.register(new OrcaUnicodeProvider(baseProvider))
  }
  unicode.activeVersion = ORCA_UNICODE_VERSION
}
