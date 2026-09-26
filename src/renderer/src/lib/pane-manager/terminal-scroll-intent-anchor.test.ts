// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enforceTerminalCurrentScrollIntent,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport
} from './terminal-scroll-intent'

const ROWS = 10
const SCROLLBACK = 50
const terminals: Terminal[] = []

function createTerminal(): Terminal {
  const terminal = new Terminal({ cols: 20, rows: ROWS, scrollback: SCROLLBACK })
  terminals.push(terminal)
  return terminal
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

async function writeLines(terminal: Terminal, from: number, count: number): Promise<void> {
  let data = ''
  for (let i = from; i < from + count; i += 1) {
    data += `line-${i}\r\n`
  }
  await write(terminal, data)
}

function topVisibleLine(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  return buffer.getLine(buffer.viewportY)?.translateToString(true) ?? ''
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
})

describe('pinned scroll intent anchoring', () => {
  it('restores the pinned content after scrollback trimming renumbers lines', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 100)
    terminal.scrollToLine(20)
    markTerminalPinnedViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)

    await writeLines(terminal, 100, 12)
    // xterm keeps a user-scrolled viewport on the same content while trimming.
    expect(terminal.buffer.active.viewportY).toBe(8)
    expect(topVisibleLine(terminal)).toBe(pinnedContent)

    // A mouse report or typed key snaps xterm to the bottom before Orca restores.
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.buffer.active.viewportY).toBe(8)
    expect(topVisibleLine(terminal)).toBe(pinnedContent)
  })

  it('restores the same absolute line when nothing was trimmed', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 30)
    terminal.scrollToLine(5)
    markTerminalPinnedViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)

    await writeLines(terminal, 30, 4)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.buffer.active.viewportY).toBe(5)
    expect(topVisibleLine(terminal)).toBe(pinnedContent)
  })

  it('falls back to the recorded line once the pinned line is trimmed away', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 100)
    terminal.scrollToLine(3)
    markTerminalPinnedViewport(terminal)

    await writeLines(terminal, 100, 20)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.buffer.active.viewportY).toBe(3)
  })

  it('re-anchors when the user moves the pin', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 100)
    terminal.scrollToLine(30)
    markTerminalPinnedViewport(terminal)
    terminal.scrollToLine(25)
    syncTerminalScrollIntentFromViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)

    await writeLines(terminal, 100, 5)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.buffer.active.viewportY).toBe(20)
    expect(topVisibleLine(terminal)).toBe(pinnedContent)
  })
})
