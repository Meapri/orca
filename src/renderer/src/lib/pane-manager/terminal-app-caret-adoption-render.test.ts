// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from './pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import { applyTerminalAppearance } from '@/components/terminal-pane/terminal-appearance'
import {
  commit,
  compose,
  installGridPreeditTestHooks,
  openTerminal,
  renderedRow,
  settle,
  textBeforeCursor,
  write
} from '@/components/terminal-pane/terminal-ime-grid-preedit-test-rig'
import {
  installTerminalAppCaretAdoption,
  setTerminalAppCaretAdoptionEnabled
} from './terminal-app-caret-adoption'
import { installTerminalImeCandidateAnchor } from './terminal-ime-candidate-anchor'

const FIXTURES = join(__dirname, '../../../../main/runtime/__fixtures__')
const CURSOR_AGENT_TYPED = readFileSync(join(FIXTURES, 'cursor-agent-ime-korean-typed.txt'), 'utf8')
const REPAINT = `${'\x1b[2K\x1b[1A'.repeat(5)}\x1b[2K\x1b[G`
// The last repaint moves cursor-agent's caret from "a" onto "b"; everything before it sets up.
const LAST_FRAME_AT = CURSOR_AGENT_TYPED.lastIndexOf(REPAINT)
const CURSOR_AGENT_SETUP = CURSOR_AGENT_TYPED.slice(0, LAST_FRAME_AT)
const CURSOR_AGENT_LAST_FRAME = CURSOR_AGENT_TYPED.slice(LAST_FRAME_AT)

installGridPreeditTestHooks()

const cleanups: (() => void)[] = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  setTerminalAppCaretAdoptionEnabled(false)
})

function adopt(terminal: Terminal): void {
  const cleanup = installTerminalAppCaretAdoption(terminal)
  expect(cleanup).not.toBeNull()
  cleanups.push(cleanup!)
  setTerminalAppCaretAdoptionEnabled(true)
}

/** A modifier the user pressed; focus first so xterm draws a cursor at all, as it would live. */
function pressKey(terminal: Terminal): void {
  terminal.focus()
  terminal.textarea!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', bubbles: true })
  )
}

async function openCursorAgent(): Promise<{ terminal: Terminal; container: HTMLElement }> {
  const { terminal, container } = openTerminal({ cols: 100, rows: 30 })
  adopt(terminal)
  await write(terminal, CURSOR_AGENT_SETUP)
  pressKey(terminal)
  await write(terminal, CURSOR_AGENT_LAST_FRAME)
  await settle()
  return { terminal, container }
}

function cursorElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.xterm-rows .xterm-cursor'))
}

function spanAt(container: HTMLElement, row: number, text: string): HTMLElement {
  const span = Array.from(renderedRow(container, row).children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.textContent === text
  )
  if (!span) {
    throw new Error(`no "${text}" span on row ${row}`)
  }
  return span
}

describe('adopted app caret in the DOM renderer', () => {
  it('draws the terminal cursor on cursor-agent’s caret and clears its inverse only there', async () => {
    const { terminal, container } = await openCursorAgent()

    expect(terminal.modes.showCursor).toBe(false)
    expect(cursorElements(container)).toHaveLength(1)
    expect(textBeforeCursor(container, 9)).toBe('  → 안녕 하세요a한')
    const caret = spanAt(container, 9, 'b')
    expect(caret.classList.contains('xterm-cursor')).toBe(true)
    // Drawn over the input box's own background (SGR 48;5;233), not the app's inverse of it.
    expect(caret.classList.contains('xterm-bg-233')).toBe(true)
    // Presentation only: the buffer keeps the app's inverse cell.
    const buffer = terminal.buffer.active
    expect(
      buffer
        .getLine(buffer.baseY + 9)
        ?.getCell(18)
        ?.isInverse()
    ).not.toBe(0)
  })

  it('keeps the app’s rendering when the setting is off', async () => {
    const { container } = await openCursorAgent()
    setTerminalAppCaretAdoptionEnabled(false)
    await settle()

    expect(cursorElements(container)).toHaveLength(0)
    expect(spanAt(container, 9, 'b').classList.contains('xterm-bg-257')).toBe(true)
  })

  it('hands the row back to the app when the real cursor is shown', async () => {
    const { terminal, container } = await openCursorAgent()
    // Only the parked cursor's row is dirtied by this write; the caret row must still repaint.
    await write(terminal, '\x1b[?25h')
    await settle()

    const cursors = cursorElements(container)
    expect(cursors).toHaveLength(1)
    expect(renderedRow(container, 14).contains(cursors[0])).toBe(true)
    const caret = spanAt(container, 9, 'b')
    expect(caret.classList.contains('xterm-cursor')).toBe(false)
    expect(caret.classList.contains('xterm-bg-257')).toBe(true)
  })

  it('never adopts one cell of a highlighted run, while the lone caret beside it is', async () => {
    const { terminal, container } = openTerminal({ cols: 40, rows: 4 })
    adopt(terminal)
    await write(terminal, '\x1b[?25l\x1b[7m menu \x1b[27m\r\n> a')
    pressKey(terminal)
    await write(terminal, '\x1b[7mb\x1b[27m')
    await settle()

    expect(cursorElements(container)).toHaveLength(1)
    expect(textBeforeCursor(container, 1)).toBe('> a')
    expect(spanAt(container, 0, ' menu ').classList.contains('xterm-bg-257')).toBe(true)
    expect(spanAt(container, 1, 'b').classList.contains('xterm-bg-257')).toBe(false)
  })

  it('lets the IME caret win and only moves the cursor forward through a commit and its echo', async () => {
    const { terminal, container } = await openCursorAgent()
    cleanups.push(installTerminalImeCandidateAnchor(terminal)!)
    const before = [textBeforeCursor(container, 9)]

    compose(terminal, '가')
    await settle()
    before.push(textBeforeCursor(container, 9))
    expect(cursorElements(container)).toHaveLength(1)

    await commit(terminal, '가')
    before.push(textBeforeCursor(container, 9))

    await write(
      terminal,
      CURSOR_AGENT_LAST_FRAME.replace('a한\x1b[7mb\x1b[27m  ', 'a한가\x1b[7mb\x1b[27m')
    )
    await settle()
    before.push(textBeforeCursor(container, 9))
    expect(cursorElements(container)).toHaveLength(1)
    expect(spanAt(container, 9, 'b').classList.contains('xterm-cursor')).toBe(true)

    expect(before).toEqual([
      '  → 안녕 하세요a한',
      '  → 안녕 하세요a한가',
      '  → 안녕 하세요a한가',
      '  → 안녕 하세요a한가'
    ])
  })

  it('follows the terminal appearance setting, on unless explicitly disabled', async () => {
    const { terminal, container } = await openCursorAgent()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a manager without panes only needs these members.
    const manager = { getPanes: () => [], setPaneStyleOptions: vi.fn() } as unknown as PaneManager
    const settings = getDefaultSettings('/tmp')
    const apply = async (terminalAdoptAppCaret: boolean | undefined): Promise<void> => {
      applyTerminalAppearance(
        manager,
        { ...settings, terminalAdoptAppCaret },
        true,
        new Map(),
        new Map(),
        'false',
        new Map(),
        new Map()
      )
      await settle()
    }

    expect(settings.terminalAdoptAppCaret).toBe(true)
    await apply(false)
    expect(cursorElements(container)).toHaveLength(0)
    await apply(undefined)
    // Re-enabling waits for the next typed move, so a stale caret is never adopted by a toggle.
    expect(cursorElements(container)).toHaveLength(0)
    pressKey(terminal)
    await write(
      terminal,
      CURSOR_AGENT_LAST_FRAME.replace('a한\x1b[7mb\x1b[27m', '\x1b[7ma\x1b[27m한b')
    )
    await settle()
    expect(textBeforeCursor(container, 9)).toBe('  → 안녕 하세요')
  })
})
