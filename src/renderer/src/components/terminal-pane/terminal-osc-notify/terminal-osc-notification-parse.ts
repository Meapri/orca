/**
 * Terminal-native notification and progress escapes:
 * - OSC 9 ; <message>              iTerm2 desktop notification
 * - OSC 9 ; 4 ; <state> ; <pct>    ConEmu / Windows Terminal progress
 * - OSC 777 ; notify ; <title> ; <body>   rxvt-unicode / Ghostty / foot notification
 */

export type TerminalProgressState = 'normal' | 'error' | 'indeterminate' | 'paused'

export type TerminalOscNotification = { title: string | null; body: string }

export type TerminalOscProgress =
  | { kind: 'clear' }
  | { kind: 'set'; state: TerminalProgressState; percent: number | null }

export type TerminalOsc9Event =
  | { kind: 'notification'; notification: TerminalOscNotification }
  | { kind: 'progress'; progress: TerminalOscProgress }

const NOTIFICATION_TITLE_MAX_LENGTH = 120
const NOTIFICATION_BODY_MAX_LENGTH = 500
// Why: ConEmu reserves `9;<number>;…` for sub-commands (cwd, sleep, progress…); only 4 is progress.
const CONEMU_SUBCOMMAND_RE = /^(\d+)(?:;|$)/
// eslint-disable-next-line no-control-regex -- strip C0/C1 controls from untrusted program text
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]+/g

const PROGRESS_STATE_BY_CODE: Record<string, TerminalProgressState | 'clear'> = {
  '0': 'clear',
  '1': 'normal',
  '2': 'error',
  '3': 'indeterminate',
  '4': 'paused'
}

function sanitizeNotificationText(value: string | undefined, maxLength: number): string {
  const normalized = (value ?? '').replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

function parseProgressPercent(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : Math.min(100, Math.max(0, parsed))
}

export function parseOsc9Payload(payload: string): TerminalOsc9Event | null {
  const subcommand = CONEMU_SUBCOMMAND_RE.exec(payload)
  if (subcommand) {
    if (subcommand[1] !== '4') {
      return null
    }
    const [, stateCode = '', percentText] = payload.split(';')
    const state = PROGRESS_STATE_BY_CODE[stateCode.trim()]
    if (!state) {
      return null
    }
    if (state === 'clear') {
      return { kind: 'progress', progress: { kind: 'clear' } }
    }
    return {
      kind: 'progress',
      progress: {
        kind: 'set',
        state,
        percent: state === 'indeterminate' ? null : parseProgressPercent(percentText)
      }
    }
  }
  const body = sanitizeNotificationText(payload, NOTIFICATION_BODY_MAX_LENGTH)
  return body ? { kind: 'notification', notification: { title: null, body } } : null
}

export function parseOsc777Payload(payload: string): TerminalOscNotification | null {
  const [command, rawTitle, ...bodyParts] = payload.split(';')
  if (command !== 'notify') {
    return null
  }
  const title = sanitizeNotificationText(rawTitle, NOTIFICATION_TITLE_MAX_LENGTH)
  // Why: the body is the remainder, so a `;` inside the message is text, not a field break.
  const body = sanitizeNotificationText(bodyParts.join(';'), NOTIFICATION_BODY_MAX_LENGTH)
  if (!title && !body) {
    return null
  }
  return body ? { title: title || null, body } : { title: null, body: title }
}
