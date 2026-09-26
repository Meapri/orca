import type { Terminal } from '@xterm/xterm'
import {
  readTerminalClipboardSelection,
  type TerminalClipboardSelectionSource
} from './terminal-clipboard-selection-text'

type TerminalSelectionCopyOptions = {
  terminal: TerminalClipboardSelectionSource & Pick<Terminal, 'clearSelection'>
  writeClipboardText: (text: string) => Promise<void>
  clearSelectionOnSuccess?: boolean
  /** Runs only after the clipboard write resolved. */
  onCopied?: () => void
}

export async function copyTerminalSelection({
  terminal,
  writeClipboardText,
  clearSelectionOnSuccess = false,
  onCopied
}: TerminalSelectionCopyOptions): Promise<boolean> {
  const selection = readTerminalClipboardSelection(terminal)
  if (!selection) {
    return false
  }

  await writeClipboardText(selection)
  // Keep failed-copy text selected for retry.
  if (clearSelectionOnSuccess) {
    terminal.clearSelection()
  }
  onCopied?.()
  return true
}
