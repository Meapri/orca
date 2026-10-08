import { KITTY_REPORT_EVENT_TYPES } from '../../../../shared/terminal-kitty-keyboard-flags'
import { encodeTerminalKittyCsiU } from './terminal-kitty-csi-u-encoding'
import { kittyEncodesModifiedTextKeys } from './terminal-option-shortcut-policy'

type LineEditingChordEvent = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type TerminalLineEditingChordContext = {
  isMac: boolean
  getKittyKeyboardFlags: () => number
  // Why: lazy so local ConPTY lookup runs only for the chords PSReadLine binds itself.
  isLocalWindowsConptyPane?: () => boolean
}

/** 'yield' means xterm's own encoding is authoritative and no later fallback may run. */
export type TerminalLineEditingChordResult = { type: 'sendInput'; data: string } | { type: 'yield' }

type ChordModifier = 'cmd' | 'alt' | 'ctrl'

type LineEditingChord = {
  modifier: ChordModifier
  key: string
  platform: 'mac' | 'non-mac' | 'any'
  /** Legacy readline bytes, or a C0 control letter re-encoded for kitty panes. */
  send: { bytes: string } | { controlLetter: string }
  /** Kitty panes: let xterm's native CSI encoding reach the app. */
  yieldToKitty?: boolean
  yieldToLocalConpty?: boolean
  excludeNumpad?: boolean
}

// Why: one table so the GUI line-editing vocabulary (line start/end, word jump, word/line delete)
// stays consistent across platforms and is unit-testable without the shortcut policy's plumbing.
export const TERMINAL_LINE_EDITING_CHORDS: readonly LineEditingChord[] = [
  { modifier: 'ctrl', key: 'Backspace', platform: 'any', send: { bytes: '\x17' } },
  { modifier: 'cmd', key: 'Backspace', platform: 'mac', send: { controlLetter: 'u' } },
  { modifier: 'cmd', key: 'Delete', platform: 'mac', send: { controlLetter: 'k' } },
  // Why: xterm.js has no Cmd+Arrow mapping; translate Cmd+←/→ to readline Ctrl+A/Ctrl+E (iTerm2/Ghostty).
  { modifier: 'cmd', key: 'ArrowLeft', platform: 'mac', send: { controlLetter: 'a' } },
  { modifier: 'cmd', key: 'ArrowRight', platform: 'mac', send: { controlLetter: 'e' } },
  // Why: a kitty-protocol TUI binds the CSI 127;3u xterm emits natively; \x1b\x7f would bypass it.
  {
    modifier: 'alt',
    key: 'Backspace',
    platform: 'any',
    send: { bytes: '\x1b\x7f' },
    yieldToKitty: true
  },
  // Why: readline leaves xterm's CSI 3;3~ unbound and prints `~` (#21491); \ed is kill-word everywhere.
  {
    modifier: 'alt',
    key: 'Delete',
    platform: 'any',
    send: { bytes: '\x1bd' },
    yieldToKitty: true,
    excludeNumpad: true
  },
  // Why: readline doesn't bind xterm's \e[1;3D/C for alt+←/→; \eb/\ef is iTerm2's "Esc+" behavior.
  {
    modifier: 'alt',
    key: 'ArrowLeft',
    platform: 'any',
    send: { bytes: '\x1bb' },
    yieldToKitty: true,
    excludeNumpad: true
  },
  {
    modifier: 'alt',
    key: 'ArrowRight',
    platform: 'any',
    send: { bytes: '\x1bf' },
    yieldToKitty: true,
    excludeNumpad: true
  },
  // Why: Mac reserves Ctrl+Arrow for Spaces; local ConPTY (PSReadLine) binds these chords itself.
  {
    modifier: 'ctrl',
    key: 'ArrowLeft',
    platform: 'non-mac',
    send: { bytes: '\x1bb' },
    yieldToLocalConpty: true
  },
  {
    modifier: 'ctrl',
    key: 'ArrowRight',
    platform: 'non-mac',
    send: { bytes: '\x1bf' },
    yieldToLocalConpty: true
  },
  {
    modifier: 'ctrl',
    key: 'Delete',
    platform: 'non-mac',
    send: { bytes: '\x1bd' },
    yieldToKitty: true,
    yieldToLocalConpty: true,
    excludeNumpad: true
  }
]

function eventModifier(event: LineEditingChordEvent): ChordModifier | null {
  if (event.shiftKey) {
    return null
  }
  const active = [event.metaKey, event.altKey, event.ctrlKey].filter(Boolean).length
  if (active !== 1) {
    return null
  }
  return event.metaKey ? 'cmd' : event.altKey ? 'alt' : 'ctrl'
}

/**
 * A synthesized control letter must look like the real Ctrl+letter press the pane would
 * receive, so kitty panes get CSI-u (press+release when event types are reported).
 */
export function encodeTerminalControlLetter(letter: string, kittyFlags: number): string {
  if (!kittyEncodesModifiedTextKeys(kittyFlags)) {
    return String.fromCharCode(letter.charCodeAt(0) & 0x1f)
  }
  const base = {
    flags: kittyFlags,
    primaryCodePoint: letter.charCodeAt(0),
    shiftKey: false,
    altKey: false,
    ctrlKey: true,
    metaKey: false
  }
  const press = encodeTerminalKittyCsiU({ ...base, type: 'press' }) ?? ''
  const release =
    (kittyFlags & KITTY_REPORT_EVENT_TYPES) !== 0
      ? (encodeTerminalKittyCsiU({ ...base, type: 'release' }) ?? '')
      : ''
  return press + release
}

export function resolveTerminalLineEditingChord(
  event: LineEditingChordEvent,
  context: TerminalLineEditingChordContext
): TerminalLineEditingChordResult | null {
  const modifier = eventModifier(event)
  if (!modifier) {
    return null
  }
  const isNumpad = event.code?.startsWith('Numpad') === true
  const chord = TERMINAL_LINE_EDITING_CHORDS.find(
    (candidate) =>
      candidate.modifier === modifier &&
      candidate.key === event.key &&
      (candidate.platform === 'any' || (candidate.platform === 'mac') === context.isMac) &&
      !(candidate.excludeNumpad && isNumpad)
  )
  if (!chord) {
    return null
  }
  if (chord.yieldToLocalConpty && context.isLocalWindowsConptyPane?.()) {
    return { type: 'yield' }
  }
  if (chord.yieldToKitty && context.getKittyKeyboardFlags() > 0) {
    return { type: 'yield' }
  }
  const data =
    'bytes' in chord.send
      ? chord.send.bytes
      : encodeTerminalControlLetter(chord.send.controlLetter, context.getKittyKeyboardFlags())
  return { type: 'sendInput', data }
}
