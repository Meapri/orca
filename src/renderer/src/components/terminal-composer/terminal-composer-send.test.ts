// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pasteTerminalText } from '../terminal-pane/terminal-bracketed-paste'
import {
  encodeTerminalComposerSubmit,
  normalizeTerminalComposerText,
  sendTerminalComposerText
} from './terminal-composer-send'

const originalGetContext = HTMLCanvasElement.prototype.getContext

describe('normalizeTerminalComposerText', () => {
  it('drops trailing line breaks but keeps interior newlines and indentation', () => {
    expect(normalizeTerminalComposerText('echo a\n  echo b\n\n')).toBe('echo a\n  echo b')
    expect(normalizeTerminalComposerText('one\r\ntwo\rthree')).toBe('one\ntwo\nthree')
    expect(normalizeTerminalComposerText('  lead')).toBe('  lead')
  })
})

describe('encodeTerminalComposerSubmit', () => {
  it('matches the Enter bytes xterm sends for each kitty mode', () => {
    expect(encodeTerminalComposerSubmit(0)).toBe('\r')
    // Disambiguate alone keeps Enter legacy, per the kitty spec.
    expect(encodeTerminalComposerSubmit(1)).toBe('\r')
    expect(encodeTerminalComposerSubmit(8)).toBe('\x1b[13u')
    expect(encodeTerminalComposerSubmit(3)).toBe('\r\x1b[13;1:3u')
    expect(encodeTerminalComposerSubmit(11)).toBe('\x1b[13u\x1b[13;1:3u')
  })
})

describe('sendTerminalComposerText', () => {
  const noWait = (): Promise<void> => Promise.resolve()

  it('submits after a successful paste, and never before it', async () => {
    const order: string[] = []
    const result = await sendTerminalComposerText(
      'ls\n',
      { submit: true },
      {
        pasteText: async (text) => {
          order.push(`paste:${text}`)
          return true
        },
        writeInput: (data) => order.push(`input:${JSON.stringify(data)}`),
        getKittyKeyboardFlags: () => 0,
        wait: noWait
      }
    )
    expect(result).toBe('sent')
    expect(order).toEqual(['paste:ls', 'input:"\\r"'])
  })

  it('only inserts when submit is off', async () => {
    const writeInput = vi.fn()
    await sendTerminalComposerText(
      'draft',
      { submit: false },
      { pasteText: async () => true, writeInput, getKittyKeyboardFlags: () => 0, wait: noWait }
    )
    expect(writeInput).not.toHaveBeenCalled()
  })

  it('does not press Enter when the paste was refused', async () => {
    const writeInput = vi.fn()
    const result = await sendTerminalComposerText(
      'rm -rf build',
      { submit: true },
      { pasteText: async () => false, writeInput, getKittyKeyboardFlags: () => 0, wait: noWait }
    )
    expect(result).toBe('failed')
    expect(writeInput).not.toHaveBeenCalled()
  })

  it('sends nothing for whitespace-only drafts', async () => {
    const pasteText = vi.fn(async () => true)
    const result = await sendTerminalComposerText(
      ' \n\n',
      { submit: true },
      { pasteText, writeInput: vi.fn(), getKittyKeyboardFlags: () => 0, wait: noWait }
    )
    expect(result).toBe('empty')
    expect(pasteText).not.toHaveBeenCalled()
  })
})

describe('composer send through the terminal paste path', () => {
  const terminals: Terminal[] = []

  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ measureText: () => ({ width: 10 }) })
    })
  })

  afterEach(() => {
    for (const terminal of terminals.splice(0)) {
      terminal.dispose()
    }
    vi.restoreAllMocks()
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: originalGetContext
    })
    document.body.replaceChildren()
  })

  async function sendThroughXterm(bracketed: boolean, text: string): Promise<string[]> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const terminal = new Terminal({ cols: 40, rows: 5 })
    terminals.push(terminal)
    terminal.open(container)
    if (bracketed) {
      await new Promise<void>((resolve) => terminal.write('\x1b[?2004h', resolve))
    }
    const sent: string[] = []
    terminal.onData((data) => sent.push(data))
    await sendTerminalComposerText(
      text,
      { submit: true },
      {
        pasteText: async (payload) => {
          pasteTerminalText(terminal, payload)
          return true
        },
        writeInput: (data) => terminal.input(data, true),
        getKittyKeyboardFlags: () => 0,
        wait: () => Promise.resolve()
      }
    )
    return sent
  }

  it('wraps multi-line text in bracketed paste when the app enabled it', async () => {
    expect(await sendThroughXterm(true, 'git add .\ngit commit\n')).toEqual([
      '\x1b[200~git add .\rgit commit\x1b[201~',
      '\r'
    ])
  })

  it('sends lines as typed input when bracketed paste is off', async () => {
    expect(await sendThroughXterm(false, 'echo 1\necho 2')).toEqual(['echo 1\recho 2', '\r'])
  })
})
