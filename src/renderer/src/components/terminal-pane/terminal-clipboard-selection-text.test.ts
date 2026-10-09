import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const settings: { current: Partial<GlobalSettings> } = { current: {} }
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: settings.current }) }
}))

const { readTerminalClipboardSelection, readTerminalRawSelection } =
  await import('./terminal-clipboard-selection-text')
const { copyTerminalSelection } = await import('./terminal-selection-copy')
const { buildXtermLinearSelectionText, readTerminalCopySelection } =
  await import('./terminal-selection-cells')
const { Terminal } = await import('@xterm/headless')

// The gutter an agent CLI paints its message behind, as xterm reports it.
const GUTTERED = ['  Retry limit is now 5.', '  Backoff starts at 2s.'].join('\n')
const UNGUTTERED = ['Retry limit is now 5.', 'Backoff starts at 2s.'].join('\n')

describe('readTerminalClipboardSelection', () => {
  beforeEach(() => {
    settings.current = {}
  })

  it('strips the gutter by default', () => {
    expect(readTerminalClipboardSelection({ getSelection: () => GUTTERED })).toBe(UNGUTTERED)
  })

  it('strips the gutter when the setting is explicitly on', () => {
    settings.current = { terminalCopyTrimsGutter: true }
    expect(readTerminalClipboardSelection({ getSelection: () => GUTTERED })).toBe(UNGUTTERED)
  })

  it('copies screen cells verbatim when the setting is off', () => {
    settings.current = { terminalCopyTrimsGutter: false }
    expect(readTerminalClipboardSelection({ getSelection: () => GUTTERED })).toBe(GUTTERED)
  })
})

describe('copyTerminalSelection gutter handling', () => {
  beforeEach(() => {
    settings.current = {}
  })

  it('writes the un-guttered text to the clipboard', async () => {
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    await copyTerminalSelection({
      terminal: { getSelection: () => GUTTERED, clearSelection: vi.fn() },
      writeClipboardText
    })
    expect(writeClipboardText).toHaveBeenCalledWith(UNGUTTERED)
  })

  it('still reports no selection for an empty xterm selection', async () => {
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    await expect(
      copyTerminalSelection({
        terminal: { getSelection: () => '', clearSelection: vi.fn() },
        writeClipboardText
      })
    ).resolves.toBe(false)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})

describe('readTerminalClipboardSelection smart copy', () => {
  const BOX = ['╭──────────╮', '│ boxed    │', '╰──────────╯']
  const range = { start: { x: 0, y: 0 }, end: { x: 20, y: 2 } }

  async function boxedTerminal(xtermText?: string) {
    const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true })
    await new Promise<void>((resolve) => term.write(BOX.join('\r\n'), resolve))
    const cells = readTerminalCopySelection(term.buffer.active, range)
    const linear = cells ? buildXtermLinearSelectionText(cells).join('\n') : ''
    return {
      getSelection: () => xtermText ?? linear,
      getSelectionPosition: () => range,
      buffer: term.buffer
    }
  }

  beforeEach(() => {
    settings.current = {}
  })

  it('strips the TUI frame from a real buffer selection', async () => {
    expect(readTerminalClipboardSelection(await boxedTerminal())).toBe('boxed')
  })

  it('falls back to xterm text when the buffer does not describe it (column selection)', async () => {
    const columnText = '──────\n boxed\n──────'
    expect(readTerminalClipboardSelection(await boxedTerminal(columnText))).toBe(columnText)
  })

  it('keeps raw copy and the off setting verbatim', async () => {
    const terminal = await boxedTerminal()
    expect(readTerminalRawSelection(terminal)).toBe(BOX.join('\n'))
    settings.current = { terminalCopyTrimsGutter: false }
    expect(readTerminalClipboardSelection(terminal)).toBe(BOX.join('\n'))
  })
})
