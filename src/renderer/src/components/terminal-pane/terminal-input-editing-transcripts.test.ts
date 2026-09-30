// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalClickToMoveCursor } from './terminal-click-to-move-cursor'
import {
  getTerminalInputSelectionEditing,
  installTerminalInputSelectionEditing,
  type TerminalInputEditingKeyEvent
} from './terminal-input-selection-editing'
import {
  installTerminalAppCaretAdoption,
  setTerminalAppCaretAdoptionEnabled
} from '@/lib/pane-manager/terminal-app-caret-adoption'

// Recorded with config/scripts/capture-agent-pty-transcript.mjs (isolated config, nothing
// submitted); each .meta.json lists every key sent and the transcript byte offset it landed at.
const FIXTURES = join(__dirname, '../../../../main/runtime/__fixtures__')
const CELL = { width: 10, height: 20 }
const LEFT = '\x1b[D'
const BS = '\x7f'

type Send = { atMs: number; text: string; transcriptByteOffset: number }
type Meta = { cols: number; rows: number; sends?: Send[] }

type Replay = {
  terminal: Terminal
  sends: Send[]
  sent: string[]
  /** Parses the capture up to the moment `sends[index]` was typed. */
  feedTo: (index: number) => Promise<void>
  press: (init: Partial<TerminalInputEditingKeyEvent> & { key: string }) => boolean
  /** The keydown every real key produces on xterm's textarea (input-start learning, caret arming). */
  keydown: () => void
  line: () => string
  cursor: () => { x: number; y: number }
}

const cleanups: (() => void)[] = []

beforeEach(() => {
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
  setTerminalAppCaretAdoptionEnabled(false)
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function write(terminal: Terminal, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function openReplay(name: string, options: { kittyFlags?: number } = {}): Replay {
  const data = readFileSync(join(FIXTURES, `${name}.txt`))
  const meta: Meta = JSON.parse(readFileSync(join(FIXTURES, `${name}.meta.json`), 'utf8'))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: meta.cols, rows: meta.rows, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  terminal.open(container)
  const screen = terminal.element?.querySelector('.xterm-screen')
  if (screen) {
    screen.getBoundingClientRect = () =>
      DOMRect.fromRect({
        x: 0,
        y: 0,
        width: meta.cols * CELL.width,
        height: meta.rows * CELL.height
      })
  }
  const kittyFlags = options.kittyFlags ?? 0
  const clickToMove = installTerminalClickToMoveCursor(terminal, {
    getMode: () => 'input-line',
    getKittyKeyboardFlags: () => kittyFlags
  })
  const editing = installTerminalInputSelectionEditing(terminal, {
    isEnabled: () => true,
    isMac: true,
    getKittyKeyboardFlags: () => kittyFlags
  })
  const disposeAdoption = installTerminalAppCaretAdoption(terminal)
  const sent: string[] = []
  const onData = terminal.onData((input) => sent.push(input))
  cleanups.push(() => {
    onData.dispose()
    disposeAdoption?.()
    editing.dispose()
    clickToMove.dispose()
    terminal.dispose()
    container.remove()
  })
  let offset = 0
  const sends = meta.sends ?? []
  return {
    terminal,
    sends,
    sent,
    feedTo: async (index) => {
      const end = index < sends.length ? sends[index].transcriptByteOffset : data.length
      await write(terminal, data.subarray(offset, end))
      offset = end
    },
    press: (init) =>
      getTerminalInputSelectionEditing(terminal)?.handleKeyDown({
        type: 'keydown',
        code: '',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 0,
        ...init
      }) ?? false,
    keydown: () =>
      terminal.textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })),
    line: () => {
      const buffer = terminal.buffer.active
      return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? ''
    },
    cursor: () => ({ x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY })
  }
}

function sendIndex(replay: Replay, text: string, from = 0): number {
  const index = replay.sends.findIndex((send, i) => i >= from && send.text === text)
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}

/** Replays the capture's typing of `text` from `first`, as the user's keys. */
async function typeRecorded(replay: Replay, first: number, text: string): Promise<number> {
  let index = first
  for (const char of text) {
    expect(replay.sends[index].text).toBe(char)
    await replay.feedTo(index)
    replay.keydown()
    replay.press({ key: char })
    index += 1
  }
  return index
}

function selectWord(replay: Replay, word: string): void {
  const buffer = replay.terminal.buffer.active
  const column = replay.line().indexOf(word)
  expect(column).toBeGreaterThanOrEqual(0)
  replay.terminal.select(column, buffer.baseY + buffer.cursorY, word.length)
}

// Line editors Orca edits for (normal buffer, no mouse reporting), with where their input starts.
const LINE_EDITORS = [
  { name: 'zsh-input-edit-keys', prompt: '%' },
  { name: 'bash-input-edit-keys', prompt: '$' },
  { name: 'codex-inline-input-edit-keys', prompt: '› ' }
] as const

describe.each(LINE_EDITORS)('GUI selection editing replayed against $name', ({ name, prompt }) => {
  it('sends the very keys the capture sent, and the echo shows the selection replaced and undone', async () => {
    const replay = openReplay(name)
    const typed = await typeRecorded(replay, 0, 'alpha beta gamma')
    const toBetaEnd = sendIndex(replay, LEFT.repeat(6))
    expect(toBetaEnd).toBe(typed)
    await replay.feedTo(toBetaEnd)
    expect(replay.line()).toBe(`${prompt}alpha beta gamma`)

    // Drag-select "beta", press Backspace: exactly the capture's Left x6 then Backspace x4.
    selectWord(replay, 'beta')
    replay.sent.length = 0
    expect(replay.press({ key: 'Backspace' })).toBe(true)
    expect(replay.sends[toBetaEnd + 1].text).toBe(BS.repeat(4))
    expect(replay.sent).toEqual([replay.sends[toBetaEnd].text + replay.sends[toBetaEnd + 1].text])

    // The app's echo of those bytes, then the replacement typed over the gap.
    const afterReplace = await typeRecorded(replay, toBetaEnd + 2, 'BETA')
    const undo = afterReplace
    await replay.feedTo(undo)
    expect(replay.line()).toBe(`${prompt}alpha BETA gamma`)

    // Cmd+Z: Backspace over "BETA" and retype "beta", the capture's next write.
    replay.sent.length = 0
    expect(replay.press({ key: 'z', code: 'KeyZ', metaKey: true })).toBe(true)
    expect(replay.sent).toEqual([replay.sends[undo].text])
    expect(replay.sends[undo].text).toBe(`${BS.repeat(4)}beta`)
    await replay.feedTo(undo + 1)
    expect(replay.line()).toBe(`${prompt}alpha beta gamma`)
    expect(replay.cursor().x).toBe(prompt.length + 'alpha beta'.length)
  })

  it('keeps Shift+Arrow as a selection, where the raw key would reach the app', async () => {
    const replay = openReplay(name)
    await typeRecorded(replay, 0, 'alpha beta gamma')
    const shiftLeft = sendIndex(replay, '\x1b[1;2D'.repeat(3))
    await replay.feedTo(shiftLeft)
    const before = replay.line()
    replay.sent.length = 0
    expect(replay.press({ key: 'ArrowLeft', shiftKey: true })).toBe(true)
    expect(replay.sent).toEqual([])
    expect(replay.terminal.getSelection()).toBe(before.slice(-1))
    // What the app did with the raw CSI 1;2D: shells print ";2D", Codex ignores it.
    await replay.feedTo(shiftLeft + 1)
    expect(replay.line().includes(';2D')).toBe(name !== 'codex-inline-input-edit-keys')
  })
})

describe('what the captured line editors do with the keys Orca could send', () => {
  it('uses Backspace, not Delete: zsh -f leaves CSI 3~ unbound and prints "~"', async () => {
    for (const { name } of LINE_EDITORS) {
      const replay = openReplay(name)
      const forwardDelete = sendIndex(replay, '\x1b[3~'.repeat(4))
      await replay.feedTo(forwardDelete + 1)
      expect(replay.line().includes('~~~~'), name).toBe(name === 'zsh-input-edit-keys')
    }
  })

  it.each([
    ['zsh-input-edit-keys', true],
    ['bash-input-edit-keys', true],
    ['claude-code-input-edit-keys', true],
    ['codex-inline-input-edit-keys', false]
  ])(
    'Ctrl+_ (the Cmd+Z fallback) is the line editor’s own undo in %s: %s',
    async (name, undoes) => {
      const replay = openReplay(name)
      const undo = sendIndex(replay, '\x1f')
      await replay.feedTo(undo)
      const before = replay.line()
      await replay.feedTo(undo + 1)
      expect(replay.line() !== before).toBe(undoes)
    }
  )
})

describe('agent CLIs that report the mouse own GUI editing themselves', () => {
  it.each([
    ['claude-code-input-edit-mouse', '❯ alpha gamma'],
    ['codex-input-edit-mouse', '› alpha  gamma']
  ])(
    '%s: Orca stays out, and the app deletes a dragged selection itself',
    async (name, deleted) => {
      const replay = openReplay(name)
      const drag = replay.sends.findIndex((send) => send.text.startsWith('\x1b[<32;'))
      await replay.feedTo(drag)
      const terminal = replay.terminal
      expect(terminal.buffer.active.type).toBe('alternate')
      expect(terminal.modes.mouseTrackingMode).toBe('any')
      selectWord(replay, 'beta')
      expect(replay.press({ key: 'Backspace' })).toBe(false)
      terminal.clearSelection()
      // The app's own reply to press, drag, release and Backspace.
      await replay.feedTo(drag + 4)
      // Claude Code separates its prompt glyph with a no-break space.
      expect(
        replay
          .line()
          .replace(/\u00a0/g, ' ')
          .trimEnd()
      ).toBe(deleted)
      // A click on the first of two rows moves the caret there; typing lands on that row.
      const q = sendIndex(replay, 'Q')
      await replay.feedTo(q + 1)
      expect(replay.line()).toContain('alQpha')
    }
  )
})

describe('cursor-agent: edits act at the adopted app caret, not the parked cursor', () => {
  // cursor-agent repaints its input box once per key with this prefix.
  const REPAINT = `${'\x1b[2K\x1b[1A'.repeat(5)}\x1b[2K\x1b[G`

  async function typedCursorAgent(): Promise<Replay> {
    setTerminalAppCaretAdoptionEnabled(true)
    // cursor-agent pushes kitty flags 1 (`CSI > 1 u`) at startup.
    const replay = openReplay('cursor-agent-ime-korean-typed', { kittyFlags: 1 })
    const [prelude, ...frames] = readFileSync(
      join(FIXTURES, 'cursor-agent-ime-korean-typed.txt'),
      'utf8'
    ).split(REPAINT)
    await write(replay.terminal, prelude)
    for (const frame of frames) {
      replay.keydown()
      await write(replay.terminal, REPAINT + frame)
    }
    return replay
  }

  it('deletes a selection with Left and Backspace counted from the caret', async () => {
    const replay = await typedCursorAgent()
    const terminal = replay.terminal
    const buffer = terminal.buffer.active
    // "→ 안녕 하세요a한b", the caret on "b" at column 18 while the cursor is parked below.
    expect(terminal.modes.showCursor).toBe(false)
    expect(replay.cursor()).not.toEqual({ x: 18, y: 9 })
    terminal.select(9, buffer.baseY + 9, 6)
    expect(terminal.getSelection()).toBe('하세요')
    replay.sent.length = 0
    expect(replay.press({ key: 'Backspace' })).toBe(true)
    expect(replay.sent).toEqual([LEFT.repeat(2) + BS.repeat(3)])
  })

  it('clicks move the caret by characters from where the app draws it', async () => {
    const replay = await typedCursorAgent()
    replay.terminal.focus()
    const init = { bubbles: true, button: 0, detail: 1 }
    const clientX = 9 * CELL.width + CELL.width / 2
    const clientY = 9 * CELL.height + CELL.height / 2
    replay.sent.length = 0
    replay.terminal.element?.dispatchEvent(
      new MouseEvent('mousedown', { ...init, clientX, clientY })
    )
    replay.terminal.element?.dispatchEvent(new MouseEvent('mouseup', { ...init, clientX, clientY }))
    // 하세요a한 lies between column 9 and the caret: five presses, however wide.
    expect(replay.sent).toEqual([LEFT.repeat(5)])
  })
})

function clickCell(replay: Replay, column: number, row: number): void {
  const init = { bubbles: true, button: 0, detail: 1 }
  const clientX = column * CELL.width + CELL.width / 2
  const clientY = row * CELL.height + CELL.height / 2
  replay.terminal.element?.dispatchEvent(new MouseEvent('mousedown', { ...init, clientX, clientY }))
  replay.terminal.element?.dispatchEvent(new MouseEvent('mouseup', { ...init, clientX, clientY }))
}

describe('click-to-move across the rows of Codex’s inline composer', () => {
  it('sends Up, then the Left presses the capture sent once Codex has moved the cursor', async () => {
    const replay = openReplay('codex-inline-input-edit-keys')
    replay.terminal.focus()
    await typeRecorded(replay, 0, 'alpha beta gamma')
    const newline = sendIndex(replay, '\n')
    await replay.feedTo(newline + 1)
    const up = await typeRecorded(replay, newline + 1, 'delta')
    expect(replay.sends[up].text).toBe('\x1b[A')
    await replay.feedTo(up)
    expect(replay.cursor()).toEqual({ x: 7, y: 12 })

    replay.sent.length = 0
    clickCell(replay, 5, 11)
    expect(replay.sent).toEqual(['\x1b[A'])
    // Codex's repaint for that Up: the cursor keeps column 7 on the first row.
    await replay.feedTo(up + 1)
    expect(replay.sent).toEqual(['\x1b[A', replay.sends[up + 1].text])
    expect(replay.sends[up + 1].text).toBe(LEFT.repeat(2))
  })

  it('does the same across a soft wrap, whose continuation row the composer indents too', async () => {
    const replay = openReplay('codex-inline-input-edit-wrap')
    replay.terminal.focus()
    const words = Array.from({ length: 30 }, (_, i) => `w${String(i + 1).padStart(2, '0')} `)
    const up = await typeRecorded(replay, 0, words.join(''))
    await replay.feedTo(up)
    expect(replay.cursor()).toEqual({ x: 26, y: 12 })
    replay.sent.length = 0
    clickCell(replay, 24, 11)
    await replay.feedTo(up + 1)
    expect(replay.sent).toEqual([replay.sends[up].text, replay.sends[up + 1].text])
  })

  it('never presses Up or Down at a shell prompt, where they recall history', async () => {
    const replay = openReplay('bash-input-edit-keys')
    replay.terminal.focus()
    const next = await typeRecorded(replay, 0, 'alpha beta gamma')
    await replay.feedTo(next)
    replay.sent.length = 0
    clickCell(replay, 3, 1)
    expect(replay.sent).toEqual([])
  })
})
