import type { Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store'
import { stripTerminalSelectionGutter } from '../../../../shared/terminal-selection-gutter'
import { matchesXtermSelectionText, readTerminalCopySelection } from './terminal-selection-cells'
import { buildTerminalSmartCopyText } from './terminal-smart-copy'

export type TerminalClipboardSelectionSource = Pick<Terminal, 'getSelection'> &
  Partial<Pick<Terminal, 'getSelectionPosition' | 'buffer'>>

function readSmartSelection(terminal: TerminalClipboardSelectionSource, xtermText: string) {
  const range = terminal.getSelectionPosition?.()
  const buffer = terminal.buffer?.active
  if (!range || !buffer) {
    return null
  }
  const selection = readTerminalCopySelection(buffer, range)
  if (!selection || !matchesXtermSelectionText(selection, xtermText)) {
    return null
  }
  // Why: xterm joins rows with CRLF on Windows; keep whatever it chose.
  return buildTerminalSmartCopyText(selection, xtermText.includes('\r\n') ? '\r\n' : '\n')
}

/**
 * The selection text every terminal clipboard path should write: screen cells
 * minus TUI frames, gutters, hard wraps and padding (#19770).
 */
export function readTerminalClipboardSelection(terminal: TerminalClipboardSelectionSource): string {
  const selection = terminal.getSelection()
  // Why: `=== false` keeps profiles saved before the setting existed on the default.
  if (!selection || useAppStore.getState().settings?.terminalCopyTrimsGutter === false) {
    return selection
  }
  try {
    const smart = readSmartSelection(terminal, selection)
    if (smart !== null) {
      return smart
    }
  } catch {
    // Why: a buffer mutated mid-read must still copy something; xterm's text is always valid.
  }
  return stripTerminalSelectionGutter(selection)
}

/** xterm's screen cells verbatim, for the explicit "Copy Raw" escape hatch. */
export function readTerminalRawSelection(terminal: Pick<Terminal, 'getSelection'>): string {
  return terminal.getSelection()
}
