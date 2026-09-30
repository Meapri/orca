// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalClickToMoveCursor } from './terminal-click-to-move-cursor'
import {
  installTerminalInputSelectionEditing,
  getTerminalInputSelectionEditing,
  type TerminalInputEditingKeyEvent
} from './terminal-input-selection-editing'

const COLS = 40
const ROWS = 6
const LEFT = '\x1b[D'
const BS = '\x7f'

type Rig = {
  terminal: Terminal
  sent: string[]
  setEnabled: (enabled: boolean) => void
  setKittyFlags: (flags: number) => void
}

const cleanups: (() => void)[] = []

beforeEach(() => {
  // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const context: CanvasRenderingContext2D = Object.create(null)
    context.measureText = () => Object.assign(Object.create(null), { width: 10 })
    return context
  })
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function openRig(options: { isMac?: boolean } = {}): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  terminal.open(container)
  let enabled = true
  let kittyFlags = 0
  const clickToMove = installTerminalClickToMoveCursor(terminal, {
    getMode: () => 'input-line',
    getKittyKeyboardFlags: () => kittyFlags
  })
  const editing = installTerminalInputSelectionEditing(terminal, {
    isEnabled: () => enabled,
    isMac: options.isMac ?? true,
    getKittyKeyboardFlags: () => kittyFlags
  })
  const sent: string[] = []
  const dataListener = terminal.onData((data) => sent.push(data))
  cleanups.push(() => {
    dataListener.dispose()
    editing.dispose()
    clickToMove.dispose()
    terminal.dispose()
    container.remove()
  })
  return {
    terminal,
    sent,
    setEnabled: (next) => (enabled = next),
    setKittyFlags: (next) => (kittyFlags = next)
  }
}

function key(
  init: Partial<TerminalInputEditingKeyEvent> & { key: string }
): TerminalInputEditingKeyEvent {
  return {
    type: 'keydown',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    ...init
  }
}

function press(rig: Rig, init: Partial<TerminalInputEditingKeyEvent> & { key: string }): boolean {
  return getTerminalInputSelectionEditing(rig.terminal)?.handleKeyDown(key(init)) ?? false
}

// "$ " prompt, a keystroke that teaches where input starts, then the program's echo of `input`.
async function promptWithInput(rig: Rig, input: string, prompt = '$ '): Promise<void> {
  await write(rig.terminal, prompt)
  rig.terminal.focus()
  rig.terminal.textarea?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Shift', bubbles: true })
  )
  await write(rig.terminal, input)
  rig.sent.length = 0
}

function selection(rig: Rig): string {
  return rig.terminal.getSelection()
}

describe('input-line selection editing', () => {
  it('replaces a dragged selection with Backspace: arrows to its end, one Backspace per character', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'alpha beta gamma')
    // "beta" is columns 8-11 after "$ alpha ".
    rig.terminal.select(8, 0, 4)
    expect(press(rig, { key: 'Backspace' })).toBe(true)
    expect(rig.sent).toEqual([LEFT.repeat(6) + BS.repeat(4)])
    expect(rig.terminal.hasSelection()).toBe(false)
  })

  it('deletes a selection before a typed key, which xterm then sends itself', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'alpha beta gamma')
    rig.terminal.select(8, 0, 4)
    expect(press(rig, { key: 'B', shiftKey: true })).toBe(false)
    expect(rig.sent).toEqual([LEFT.repeat(6) + BS.repeat(4)])
  })

  it('counts a Hangul syllable as one character and snaps to its first cell', async () => {
    const rig = openRig()
    await promptWithInput(rig, '안녕 하세요')
    // "$ 안녕 하세요": 하 at cols 7-8, 세 9-10, 요 11-12; select from 하's tail to 세.
    rig.terminal.select(8, 0, 3)
    expect(press(rig, { key: 'Delete' })).toBe(true)
    expect(rig.sent).toEqual([LEFT + BS.repeat(2)])
  })

  it('clamps a triple-click-style selection to the editable span', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'echo hi')
    rig.terminal.select(0, 0, COLS)
    expect(press(rig, { key: 'Backspace', metaKey: true })).toBe(true)
    expect(rig.sent).toEqual([BS.repeat(7)])
  })

  it('leaves a selection off the input line, and prompt-only selections, to the terminal', async () => {
    const rig = openRig()
    await write(rig.terminal, 'output line\r\n')
    await promptWithInput(rig, 'echo hi')
    rig.terminal.select(0, 0, 6)
    expect(press(rig, { key: 'Backspace' })).toBe(false)
    rig.terminal.select(0, 1, 2)
    expect(press(rig, { key: 'Backspace' })).toBe(false)
    expect(rig.sent).toEqual([])
  })

  it('does nothing left of the cursor until the input start is known', async () => {
    const rig = openRig()
    await write(rig.terminal, '$ echo hi')
    rig.terminal.select(2, 0, 4)
    expect(press(rig, { key: 'Backspace' })).toBe(false)
    expect(rig.sent).toEqual([])
  })

  it('stays out of the alternate screen, mouse-reporting apps, a hidden cursor and report-all kitty', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'echo hi')
    for (const [enter, leave] of [
      ['\x1b[?1000h', '\x1b[?1000l'],
      ['\x1b[?25l', '\x1b[?25h']
    ]) {
      await write(rig.terminal, enter)
      rig.terminal.select(7, 0, 2)
      expect(press(rig, { key: 'Backspace' })).toBe(false)
      await write(rig.terminal, leave)
    }
    rig.setKittyFlags(0b1000)
    rig.terminal.select(7, 0, 2)
    expect(press(rig, { key: 'Backspace' })).toBe(false)
    rig.setKittyFlags(0)
    rig.setEnabled(false)
    expect(press(rig, { key: 'Backspace' })).toBe(false)
    expect(rig.sent).toEqual([])
  })

  it('collapses a selection to its start or end on Left/Right', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'alpha beta gamma')
    rig.terminal.select(8, 0, 4)
    expect(press(rig, { key: 'ArrowLeft' })).toBe(true)
    rig.terminal.select(8, 0, 4)
    expect(press(rig, { key: 'ArrowRight' })).toBe(true)
    expect(rig.sent).toEqual([LEFT.repeat(10), LEFT.repeat(6)])
  })

  it('grows a selection from the cursor with Shift+Arrow, by character, word and line', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'alpha beta gamma')
    expect(press(rig, { key: 'ArrowLeft', shiftKey: true })).toBe(true)
    expect(selection(rig)).toBe('a')
    expect(press(rig, { key: 'ArrowLeft', shiftKey: true, altKey: true })).toBe(true)
    expect(selection(rig)).toBe('gamma')
    expect(press(rig, { key: 'ArrowLeft', shiftKey: true, altKey: true })).toBe(true)
    expect(selection(rig)).toBe('beta gamma')
    expect(press(rig, { key: 'ArrowLeft', shiftKey: true, metaKey: true })).toBe(true)
    expect(selection(rig)).toBe('alpha beta gamma')
    expect(press(rig, { key: 'ArrowRight', shiftKey: true, altKey: true })).toBe(true)
    expect(selection(rig)).toBe(' beta gamma')
    expect(rig.sent).toEqual([])
    expect(press(rig, { key: 'Backspace' })).toBe(true)
    expect(rig.sent).toEqual([BS.repeat(11)])
  })

  it('never lets Shift+Arrow reach a shell, which prints the unbound CSI as text', async () => {
    const rig = openRig({ isMac: false })
    await promptWithInput(rig, 'ab')
    expect(press(rig, { key: 'ArrowLeft', shiftKey: true, ctrlKey: true })).toBe(true)
    expect(selection(rig)).toBe('ab')
    expect(press(rig, { key: 'End', shiftKey: true })).toBe(true)
    expect(rig.terminal.hasSelection()).toBe(false)
    expect(rig.sent).toEqual([])
  })

  it('undoes a replacement once the echo shows it, then redoes it', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'alpha beta gamma')
    rig.terminal.select(8, 0, 4)
    press(rig, { key: 'B', shiftKey: true })
    press(rig, { key: 'E', shiftKey: true })
    // The line editor's echo of the deletion and of the typed "BE".
    await write(rig.terminal, '\x1b[10D\x1b[4P\x1b[2@BE')
    rig.sent.length = 0
    expect(press(rig, { key: 'z', code: 'KeyZ', metaKey: true })).toBe(true)
    expect(rig.sent).toEqual([`${BS.repeat(2)}beta`])
    await write(rig.terminal, '\x1b[2D\x1b[2P\x1b[4@beta')
    rig.sent.length = 0
    expect(press(rig, { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true })).toBe(true)
    expect(rig.sent).toEqual([`${BS.repeat(4)}BE`])
  })

  it('falls back to the line editor’s Ctrl+_ undo when the line no longer matches the edit', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'alpha beta gamma')
    rig.terminal.select(8, 0, 4)
    press(rig, { key: 'Backspace' })
    // The app never echoed the deletion, so "beta" is still on screen.
    rig.sent.length = 0
    expect(press(rig, { key: 'z', code: 'KeyZ', metaKey: true })).toBe(true)
    expect(rig.sent).toEqual(['\x1f'])
  })

  it('keeps Ctrl+Z as suspend on Linux and Windows unless it reverses an Orca edit', async () => {
    const rig = openRig({ isMac: false })
    await promptWithInput(rig, 'alpha beta gamma')
    expect(press(rig, { key: 'z', code: 'KeyZ', ctrlKey: true })).toBe(false)
    rig.terminal.select(8, 0, 4)
    press(rig, { key: 'Backspace' })
    await write(rig.terminal, '\x1b[10D\x1b[4P')
    rig.sent.length = 0
    expect(press(rig, { key: 'z', code: 'KeyZ', ctrlKey: true })).toBe(true)
    expect(rig.sent).toEqual(['beta'])
  })

  it('drops the undo record when another key edits the line first', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'alpha beta gamma')
    rig.terminal.select(8, 0, 4)
    press(rig, { key: 'Backspace' })
    await write(rig.terminal, '\x1b[10D\x1b[4P')
    press(rig, { key: 'ArrowLeft' })
    rig.sent.length = 0
    expect(press(rig, { key: 'z', code: 'KeyZ', metaKey: true })).toBe(true)
    expect(rig.sent).toEqual(['\x1f'])
  })

  it('deletes the selection when an IME composition starts over it', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'alpha beta gamma')
    rig.terminal.select(8, 0, 4)
    rig.terminal.textarea?.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true })
    )
    expect(rig.sent).toEqual([LEFT.repeat(6) + BS.repeat(4)])
  })

  it('uses the pane’s cursor-key mode for the arrows', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'ab cd')
    await write(rig.terminal, '\x1b[?1h\x1b[3D')
    rig.terminal.select(5, 0, 2)
    press(rig, { key: 'Backspace' })
    expect(rig.sent).toEqual(['\x1bOC'.repeat(3) + BS.repeat(2)])
    rig.sent.length = 0
    rig.terminal.select(2, 0, 1)
    press(rig, { key: 'ArrowRight' })
    expect(rig.sent).toEqual(['\x1bOD'])
  })
})
