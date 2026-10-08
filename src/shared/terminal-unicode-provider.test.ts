import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { activateOrcaTerminalUnicodeProvider } from './terminal-unicode-provider'
import {
  isCodepointInRanges,
  POST_UNICODE11_WIDE_EMOJI_RANGES,
  TEXT_DEFAULT_EMOJI_RANGES
} from './terminal-emoji-width-ranges'

const VS15 = String.fromCodePoint(0xfe0e)
const VS16 = String.fromCodePoint(0xfe0f)
const ZWJ = String.fromCodePoint(0x200d)
const KEYCAP = String.fromCodePoint(0x20e3)
const HEART = String.fromCodePoint(0x2764)
const HAN = String.fromCodePoint(0xd55c)

type Cell = { chars: string; width: number }

function createTerminal(cols = 40): Terminal {
  const terminal = new Terminal({ cols, rows: 4, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(terminal)
  return terminal
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function firstCell(terminal: Terminal, y: number): Cell | null {
  const cell = terminal.buffer.active.getLine(y)?.getCell(0)
  return cell ? { chars: cell.getChars(), width: cell.getWidth() } : null
}

async function layout(text: string): Promise<{ cursorX: number; first: Cell | null }> {
  const terminal = createTerminal()
  await write(terminal, text)
  const result = { cursorX: terminal.buffer.active.cursorX, first: firstCell(terminal, 0) }
  terminal.dispose()
  return result
}

function unicode11Width(codepoint: number): number {
  const terminal = new Terminal({ allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm exposes no public wcwidth; the headless core carries unicodeService.
  const core = terminal as unknown as { _core: { unicodeService: { wcwidth(cp: number): number } } }
  const { unicodeService } = core._core
  const width = unicodeService.wcwidth(codepoint)
  terminal.dispose()
  return width
}

const cp = (codepoint: number): string => String.fromCodePoint(codepoint)

describe('Orca terminal unicode provider emoji widths', () => {
  it.each([
    ['red heart + VS16', `${HEART}${VS16}`],
    ['keycap one', `1${VS16}${KEYCAP}`],
    ['keycap hash', `#${VS16}${KEYCAP}`],
    ['copyright + VS16', `${cp(0xa9)}${VS16}`],
    ['thermometer + VS16', `${cp(0x1f321)}${VS16}`],
    ['rainbow flag ZWJ sequence', `${cp(0x1f3f3)}${VS16}${ZWJ}${cp(0x1f308)}`],
    ['heart on fire ZWJ sequence', `${HEART}${VS16}${ZWJ}${cp(0x1f525)}`],
    ['smiling face with tear (Unicode 13)', cp(0x1f972)],
    ['melting face (Unicode 14)', cp(0x1fae0)]
  ])('budgets %s as two cells', async (_label, text) => {
    const { cursorX, first } = await layout(`${text}x`)
    expect(cursorX).toBe(3)
    expect(first).toEqual({ chars: text, width: 2 })
  })

  it.each([
    ['bare text-default heart', HEART, 1],
    ['heart + VS15 text presentation', `${HEART}${VS15}`, 1],
    ['bare digit', '1', 1],
    ['keycap without VS16', `1${KEYCAP}`, 1],
    ['VS16 after a non-emoji letter', `a${VS16}`, 1],
    ['VS16 after a Hangul syllable', `${HAN}${VS16}`, 2],
    ['VS16 after an already-wide emoji', `${cp(0x231a)}${VS16}`, 2],
    ['regional indicator pair', `${cp(0x1f1f0)}${cp(0x1f1f7)}`, 2],
    ['Hangul syllable', HAN, 2]
  ])('keeps %s at its existing width', async (_label, text, width) => {
    const { cursorX } = await layout(text)
    expect(cursorX).toBe(width)
  })

  it('wraps a base widened at the last column onto the next row', async () => {
    const terminal = createTerminal(5)
    await write(terminal, `abcd${HEART}${VS16}`)
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('abcd')
    expect(firstCell(terminal, 1)).toEqual({ chars: `${HEART}${VS16}`, width: 2 })
    expect(terminal.buffer.active.cursorX).toBe(2)
    terminal.dispose()
  })

  it('keeps plain digits and CJK text on their Unicode 11 widths', async () => {
    const { cursorX } = await layout('0123456789 한글 漢字 かな')
    expect(cursorX).toBe(10 + 1 + 4 + 1 + 4 + 1 + 4)
  })

  it('repeats a widened emoji with REP at its widened width', async () => {
    const { cursorX } = await layout(`${HEART}${VS16}\x1b[2b`)
    expect(cursorX).toBe(6)
  })
})

describe('terminal emoji width ranges', () => {
  function flatten(ranges: readonly (readonly [number, number])[]): number[] {
    return ranges.flatMap(([first, last]) =>
      Array.from({ length: last - first + 1 }, (_, i) => first + i)
    )
  }

  it.each([
    ['text-default', TEXT_DEFAULT_EMOJI_RANGES],
    ['post-Unicode-11 wide', POST_UNICODE11_WIDE_EMOJI_RANGES]
  ])('keeps the %s table sorted and non-overlapping', (_label, ranges) => {
    for (let i = 0; i < ranges.length; i++) {
      expect(ranges[i][0]).toBeLessThanOrEqual(ranges[i][1])
      if (i > 0) {
        expect(ranges[i][0]).toBeGreaterThan(ranges[i - 1][1] + 1)
      }
    }
  })

  it('lists only text-default emoji that Unicode 11 budgets as one cell', () => {
    for (const codepoint of flatten(TEXT_DEFAULT_EMOJI_RANGES)) {
      const char = cp(codepoint)
      expect(/\p{Emoji}/u.test(char) && !/\p{Emoji_Presentation}/u.test(char)).toBe(true)
      expect(unicode11Width(codepoint)).toBe(1)
    }
  })

  it('lists only emoji-presentation code points that Unicode 11 leaves one cell', () => {
    for (const codepoint of flatten(POST_UNICODE11_WIDE_EMOJI_RANGES)) {
      expect(/\p{Emoji_Presentation}/u.test(cp(codepoint))).toBe(true)
      expect(unicode11Width(codepoint)).toBe(1)
    }
  })

  it('finds range edges and rejects neighbors', () => {
    expect(isCodepointInRanges(0x2194, TEXT_DEFAULT_EMOJI_RANGES)).toBe(true)
    expect(isCodepointInRanges(0x2199, TEXT_DEFAULT_EMOJI_RANGES)).toBe(true)
    expect(isCodepointInRanges(0x2193, TEXT_DEFAULT_EMOJI_RANGES)).toBe(false)
    expect(isCodepointInRanges(0x219a, TEXT_DEFAULT_EMOJI_RANGES)).toBe(false)
  })
})
