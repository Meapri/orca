// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installTerminalClickToMoveCursor,
  isTerminalClickToMoveEligible,
  normalizeTerminalClickToMoveCursorMode,
  type ClickToMoveEligibilityInput,
  type TerminalClickToMoveCursorMode
} from './terminal-click-to-move-cursor'
import { createTerminalCommandLifecycle } from './terminal-command-lifecycle'

const originalGetContext = HTMLCanvasElement.prototype.getContext

const CELL_WIDTH = 10
const CELL_HEIGHT = 20
const COLS = 40
const ROWS = 10

const PROMPT_START = '\x1b]133;A\x07'
const COMMAND_START = '\x1b]133;C\x07'

type Rig = {
  terminal: Terminal
  sent: string[]
  setMode: (mode: TerminalClickToMoveCursorMode) => void
}

const cleanups: (() => void)[] = []

beforeEach(() => {
  // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ measureText: () => ({ width: 10 }) })
  })
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  vi.restoreAllMocks()
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: originalGetContext
  })
})

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function openRig(initialMode: TerminalClickToMoveCursorMode = 'shell-prompt'): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  terminal.open(container)
  const screen = terminal.element?.querySelector('.xterm-screen')
  if (screen) {
    screen.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: COLS * CELL_WIDTH, height: ROWS * CELL_HEIGHT })
  }
  let mode = initialMode
  const lifecycle = createTerminalCommandLifecycle({ onCommandFinished: vi.fn() })
  lifecycle.attachXtermConsumer(terminal)
  const clickToMove = installTerminalClickToMoveCursor(terminal, {
    getMode: () => mode,
    getKittyKeyboardFlags: () => 0
  })
  const sent: string[] = []
  const dataListener = terminal.onData((data) => sent.push(data))
  cleanups.push(() => {
    dataListener.dispose()
    clickToMove.dispose()
    lifecycle.dispose()
    terminal.dispose()
    container.remove()
  })
  return { terminal, sent, setMode: (next) => (mode = next) }
}

function pressKey(terminal: Terminal): void {
  terminal.textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
}

function click(
  terminal: Terminal,
  cell: { col: number; row: number },
  options: { altKey?: boolean; dragPx?: number } = {}
): void {
  const clientX = cell.col * CELL_WIDTH + CELL_WIDTH / 2
  const clientY = cell.row * CELL_HEIGHT + CELL_HEIGHT / 2
  const init = { bubbles: true, button: 0, detail: 1, altKey: options.altKey === true }
  terminal.element?.dispatchEvent(new MouseEvent('mousedown', { ...init, clientX, clientY }))
  terminal.element?.dispatchEvent(
    new MouseEvent('mouseup', { ...init, clientX: clientX + (options.dragPx ?? 0), clientY })
  )
}

// Draws "$ " at a proven prompt, learns the input start from a keystroke, then echoes input.
async function promptWithInput(rig: Rig, input: string, marks = PROMPT_START): Promise<void> {
  await write(rig.terminal, `${marks}$ `)
  rig.terminal.focus()
  pressKey(rig.terminal)
  await write(rig.terminal, input)
  rig.sent.length = 0
}

describe('installTerminalClickToMoveCursor', () => {
  it('moves left by characters, counting each Hangul syllable once', async () => {
    const rig = openRig()
    await promptWithInput(rig, '한글ab')
    // "$ 한글ab": 한 = cols 2-3, cursor at col 8. Clicking 한's right half targets 한.
    click(rig.terminal, { col: 3, row: 0 })
    expect(rig.sent).toEqual(['\x1b[D\x1b[D\x1b[D\x1b[D'])
  })

  it('moves right within typed input and stops at its end', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'echo')
    rig.terminal.write('\x1b[4D')
    await write(rig.terminal, '')
    click(rig.terminal, { col: 30, row: 0 })
    expect(rig.sent).toEqual(['\x1b[C\x1b[C\x1b[C\x1b[C'])
  })

  it('does nothing at a shell without prompt marks in shell-prompt mode', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'echo', '')
    click(rig.terminal, { col: 2, row: 0 })
    expect(rig.sent).toEqual([])
  })

  it('uses the learned input line without prompt marks in input-line mode', async () => {
    const rig = openRig('input-line')
    await promptWithInput(rig, 'echo', '')
    click(rig.terminal, { col: 2, row: 0 })
    expect(rig.sent).toEqual(['\x1b[D\x1b[D\x1b[D\x1b[D'])
  })

  it('stays inert while a command runs after OSC 133;C', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'cat')
    await write(rig.terminal, `\r\n${COMMAND_START}`)
    pressKey(rig.terminal)
    await write(rig.terminal, 'typed')
    click(rig.terminal, { col: 1, row: 1 })
    expect(rig.sent).toEqual([])
  })

  it('leaves clicks to mouse-reporting apps and the alternate screen', async () => {
    const rig = openRig('input-line')
    await promptWithInput(rig, 'echo')
    await write(rig.terminal, '\x1b[?1000h')
    click(rig.terminal, { col: 2, row: 0 })
    expect(rig.sent.filter((data) => data.startsWith('\x1b[D'))).toEqual([])
    await write(rig.terminal, '\x1b[?1000l\x1b[?1049h')
    rig.sent.length = 0
    click(rig.terminal, { col: 2, row: 0 })
    expect(rig.sent).toEqual([])
  })

  it('ignores drags and the click that focuses the pane', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'echo')
    click(rig.terminal, { col: 2, row: 0 }, { dragPx: 30 })
    expect(rig.sent).toEqual([])
    rig.terminal.blur()
    click(rig.terminal, { col: 2, row: 0 })
    expect(rig.sent).toEqual([])
  })

  it('ignores clicks off the cursor line and when the setting is off', async () => {
    const rig = openRig()
    await promptWithInput(rig, 'echo')
    click(rig.terminal, { col: 2, row: 3 })
    expect(rig.sent).toEqual([])
    rig.setMode('off')
    click(rig.terminal, { col: 2, row: 0 })
    expect(rig.sent).toEqual([])
  })

  it('owns alt-click in the normal buffer and returns it to xterm on the alt screen', async () => {
    const rig = openRig()
    await promptWithInput(rig, '한글', '')
    click(rig.terminal, { col: 2, row: 0 }, { altKey: true })
    expect(rig.terminal.options.altClickMovesCursor).toBe(false)
    expect(rig.sent).toEqual(['\x1b[D\x1b[D'])
    await write(rig.terminal, '\x1b[?1049h')
    expect(rig.terminal.options.altClickMovesCursor).toBe(true)
  })
})

describe('isTerminalClickToMoveEligible', () => {
  const eligible: ClickToMoveEligibilityInput = {
    mode: 'shell-prompt',
    explicit: false,
    phase: 'prompt',
    bufferType: 'normal',
    mouseTrackingMode: 'none',
    showCursor: true,
    hadSelection: false,
    hasSelection: false,
    wasFocused: true,
    linkHovered: false,
    composing: false
  }

  it('accepts a focused plain click at a proven prompt', () => {
    expect(isTerminalClickToMoveEligible(eligible)).toBe(true)
  })

  it.each<[string, Partial<ClickToMoveEligibilityInput>]>([
    ['hidden cursor', { showCursor: false }],
    ['selection dismissal', { hadSelection: true }],
    ['link click', { linkHovered: true }],
    ['IME preedit', { composing: true }],
    ['running command', { phase: 'running' }],
    ['unmarked shell', { phase: 'unknown' }]
  ])('rejects %s', (_label, overrides) => {
    expect(isTerminalClickToMoveEligible({ ...eligible, ...overrides })).toBe(false)
  })

  it('lets input-line mode and explicit alt-click skip the prompt-phase gate', () => {
    expect(
      isTerminalClickToMoveEligible({ ...eligible, mode: 'input-line', phase: 'running' })
    ).toBe(true)
    expect(isTerminalClickToMoveEligible({ ...eligible, explicit: true, phase: 'unknown' })).toBe(
      true
    )
    expect(
      isTerminalClickToMoveEligible({ ...eligible, explicit: true, mouseTrackingMode: 'vt200' })
    ).toBe(false)
  })

  it('normalizes unknown persisted modes to the default', () => {
    expect(normalizeTerminalClickToMoveCursorMode(undefined)).toBe('shell-prompt')
    expect(normalizeTerminalClickToMoveCursorMode('bogus')).toBe('shell-prompt')
    expect(normalizeTerminalClickToMoveCursorMode('off')).toBe('off')
  })
})
