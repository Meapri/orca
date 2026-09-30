// @vitest-environment happy-dom
/**
 * A commit stays drawn in the grid, as plain text, until the pty echoes it. TUIs repaint later
 * than the IME commits (cursor-agent took 15–113 ms in its captured transcript), and without the
 * hold the syllable blanks and the cursor steps back until the echo lands. Nothing extra is sent.
 */
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { isTerminalImePreeditDrawn } from '@/lib/pane-manager/terminal-ime-grid-preedit'
import {
  compose,
  compositionEvent,
  installGridPreeditTestHooks,
  openTerminal,
  renderedText,
  settle,
  textBeforeCursor,
  underlinedText,
  write
} from './terminal-ime-grid-preedit-test-rig'

installGridPreeditTestHooks()

/** One committed syllable, appended to the textarea the way the IME grows it. */
async function typed(terminal: Terminal, syllable: string): Promise<void> {
  const textarea = terminal.textarea!
  const before = textarea.value
  textarea.dispatchEvent(compositionEvent('compositionstart', ''))
  textarea.value = before + syllable
  textarea.dispatchEvent(compositionEvent('compositionupdate', syllable))
  textarea.dispatchEvent(compositionEvent('compositionend', syllable))
  await settle()
}

function keydown(terminal: Terminal, key: string, keyCode: number): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'keyCode', { value: keyCode })
  terminal.textarea!.dispatchEvent(event)
}

/** Text the input system inserts outside a composition (a space or punctuation after a syllable). */
function insertText(terminal: Terminal, text: string): void {
  terminal.textarea!.dispatchEvent(
    new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true })
  )
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('in-grid IME commit held until echo', () => {
  it('keeps the commit drawn, not underlined, with the cursor after it until the echo', async () => {
    const { container, terminal, sent } = openTerminal()
    await write(terminal, '$ ')
    terminal.focus()
    await typed(terminal, '한')

    expect(sent).toEqual(['한'])
    expect(renderedText(container, 0)).toBe('$ 한')
    expect(underlinedText(container, 0)).toBe('')
    expect(textBeforeCursor(container, 0)).toBe('$ 한')
    expect(isTerminalImePreeditDrawn(terminal)).toBe(true)

    await write(terminal, '한')
    expect(isTerminalImePreeditDrawn(terminal)).toBe(false)
    expect(renderedText(container, 0)).toBe('$ 한')
    expect(textBeforeCursor(container, 0)).toBe('$ 한')
    expect(sent).toEqual(['한'])
  })

  it('draws the next syllable after a held commit and leaves it in place when the echo lands', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, '$ ')
    terminal.focus()
    await typed(terminal, '안')
    compose(terminal, '녀')
    await waitMs(30)

    expect(renderedText(container, 0)).toBe('$ 안녀')
    expect(underlinedText(container, 0)).toBe('녀')
    expect(textBeforeCursor(container, 0)).toBe('$ 안녀')

    await write(terminal, '안')
    await waitMs(30)
    expect(renderedText(container, 0)).toBe('$ 안녀')
    expect(underlinedText(container, 0)).toBe('녀')
    expect(textBeforeCursor(container, 0)).toBe('$ 안녀')
  })

  it('consumes commits stacked before a slow echo one echo at a time', async () => {
    const { container, terminal, sent } = openTerminal()
    await write(terminal, '$ ')
    await typed(terminal, '안')
    await typed(terminal, '녕 ')
    expect(sent).toEqual(['안', '녕 '])
    expect(renderedText(container, 0)).toBe('$ 안녕')

    await write(terminal, '안')
    expect(isTerminalImePreeditDrawn(terminal)).toBe(true)
    expect(renderedText(container, 0)).toBe('$ 안녕')

    await write(terminal, '녕 ')
    expect(isTerminalImePreeditDrawn(terminal)).toBe(false)
  })

  it('lays the next syllable after a space the text system inserted before the echo', async () => {
    const { container, terminal, sent } = openTerminal()
    await write(terminal, '$ ')
    terminal.focus()
    await typed(terminal, '요')
    // macOS: Space commits the syllable, then arrives as its own insertText.
    insertText(terminal, ' ')
    compose(terminal, '반')
    await waitMs(30)

    expect(sent).toEqual(['요', ' '])
    expect(renderedText(container, 0)).toBe('$ 요 반')
    expect(underlinedText(container, 0)).toBe('반')

    await write(terminal, '요 ')
    await waitMs(30)
    expect(renderedText(container, 0)).toBe('$ 요 반')
    expect(textBeforeCursor(container, 0)).toBe('$ 요 반')
  })

  it('keeps the held commit through a printable keydown and holds the text it types', async () => {
    const { container, terminal, sent } = openTerminal()
    await write(terminal, '$ ')
    terminal.focus()
    await typed(terminal, '요')
    keydown(terminal, '!', 49)
    compose(terminal, '반')
    await waitMs(30)

    expect(sent).toEqual(['요', '!'])
    expect(renderedText(container, 0)).toBe('$ 요!반')

    // Echoed one write at a time, each held piece is consumed as the cursor passes it.
    await write(terminal, '요')
    expect(isTerminalImePreeditDrawn(terminal)).toBe(true)
    await write(terminal, '!')
    await waitMs(30)
    expect(renderedText(container, 0)).toBe('$ 요!반')
    expect(underlinedText(container, 0)).toBe('반')
  })

  it('holds nothing extra for typed text when no commit is held', async () => {
    const { container, terminal, sent } = openTerminal()
    await write(terminal, '$ ')
    terminal.focus()
    insertText(terminal, ' ')
    compose(terminal, '가')
    await waitMs(30)

    expect(sent).toEqual([' '])
    expect(renderedText(container, 0)).toBe('$ 가')
  })

  it('drops a commit the app never echoes once the hold expires', async () => {
    const { container, terminal, sent } = openTerminal()
    await write(terminal, 'Password: ')
    await typed(terminal, '한')
    expect(renderedText(container, 0)).toBe('Password: 한')

    await waitMs(300)
    expect(isTerminalImePreeditDrawn(terminal)).toBe(false)
    expect(renderedText(container, 0)).toBe('Password:')
    expect(sent).toEqual(['한'])
  })

  it('drops the held commit at once when the app repaints the input some other way', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, '$ ')
    await typed(terminal, '한')

    await write(terminal, '\r\x1b[K$ x')
    expect(isTerminalImePreeditDrawn(terminal)).toBe(false)
    await waitMs(30)
    expect(renderedText(container, 0)).toBe('$ x')
  })

  it('drops the held commit on a key the app handles itself, but not on a modifier', async () => {
    const { terminal } = openTerminal()
    await write(terminal, '$ ')
    await typed(terminal, '한')

    keydown(terminal, 'Shift', 16)
    expect(isTerminalImePreeditDrawn(terminal)).toBe(true)
    keydown(terminal, 'Backspace', 8)
    expect(isTerminalImePreeditDrawn(terminal)).toBe(false)
  })

  it('waits out a repaint that hides the cursor, then settles on the shown caret', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, '$ ')
    await typed(terminal, '한')

    // Claude Code's frames hide the cursor and pass through the bottom row before the caret.
    await write(terminal, '\x1b[?25l\x1b[6;1H')
    expect(isTerminalImePreeditDrawn(terminal)).toBe(true)
    await waitMs(30)
    expect(renderedText(container, 0)).toBe('$ 한')
    expect(renderedText(container, 5)).toBe('')

    await write(terminal, '\x1b[1;3H한\x1b[?25h')
    expect(isTerminalImePreeditDrawn(terminal)).toBe(false)
  })

  it('keeps a preedit on the last shown cursor while a repaint parks the hidden cursor', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, '$ ')
    compose(terminal, '가')

    await write(terminal, '\x1b[?25l\x1b[6;1H')
    await waitMs(30)
    expect(renderedText(container, 0)).toBe('$ 가')
    expect(renderedText(container, 5)).toBe('')

    await write(terminal, '\x1b[1;3H\x1b[?25h')
    await waitMs(30)
    expect(renderedText(container, 0)).toBe('$ 가')
  })

  it('settles only after a synchronized-output frame ends', async () => {
    const { terminal } = openTerminal()
    await write(terminal, '$ ')
    await typed(terminal, '한')

    await write(terminal, '\x1b[?2026h\x1b[1;3H한')
    expect(isTerminalImePreeditDrawn(terminal)).toBe(true)
    await write(terminal, '\x1b[?2026l')
    expect(isTerminalImePreeditDrawn(terminal)).toBe(false)
  })

  it('holds nothing on the overlay path', async () => {
    const { container, terminal } = openTerminal({ inGrid: false })
    await write(terminal, '$ ')
    await typed(terminal, '한')

    expect(isTerminalImePreeditDrawn(terminal)).toBe(false)
    expect(renderedText(container, 0)).toBe('$')
  })
})
