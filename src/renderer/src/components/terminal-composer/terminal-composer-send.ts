import {
  KITTY_REPORT_EVENT_TYPES,
  kittyReportsAllKeysAsEscapeCodes
} from '../../../../shared/terminal-kitty-keyboard-flags'
import { encodeTerminalKittyCsiU } from '../terminal-pane/terminal-kitty-csi-u-encoding'

// Why: same beat Orca's agent draft delivery waits so a TUI sees the paste end before Enter.
export const TERMINAL_COMPOSER_SUBMIT_DELAY_MS = 50

/** Trailing line breaks would become an extra blank submit; keep interior newlines verbatim. */
export function normalizeTerminalComposerText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
}

/** The bytes a real Enter press produces in this pane, mirroring xterm's kitty encoder. */
export function encodeTerminalComposerSubmit(kittyFlags: number): string {
  const enter = {
    flags: kittyFlags,
    primaryCodePoint: 13,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false
  }
  const press = kittyReportsAllKeysAsEscapeCodes(kittyFlags)
    ? (encodeTerminalKittyCsiU({ ...enter, type: 'press' }) ?? '\r')
    : '\r'
  const release =
    (kittyFlags & KITTY_REPORT_EVENT_TYPES) !== 0
      ? (encodeTerminalKittyCsiU({ ...enter, type: 'release' }) ?? '')
      : ''
  return press + release
}

export type TerminalComposerSendDeps = {
  /** Orca's terminal paste path: bracketed when the app enabled it, chunked, host-aware. */
  pasteText: (text: string) => Promise<boolean>
  writeInput: (data: string) => void
  getKittyKeyboardFlags: () => number
  wait?: (ms: number) => Promise<void>
}

export type TerminalComposerSendResult = 'sent' | 'empty' | 'failed'

export async function sendTerminalComposerText(
  text: string,
  options: { submit: boolean },
  deps: TerminalComposerSendDeps
): Promise<TerminalComposerSendResult> {
  const payload = normalizeTerminalComposerText(text)
  if (!payload.trim()) {
    return 'empty'
  }
  if (!(await deps.pasteText(payload))) {
    return 'failed'
  }
  if (options.submit) {
    const wait =
      deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    await wait(TERMINAL_COMPOSER_SUBMIT_DELAY_MS)
    deps.writeInput(encodeTerminalComposerSubmit(deps.getKittyKeyboardFlags()))
  }
  return 'sent'
}
