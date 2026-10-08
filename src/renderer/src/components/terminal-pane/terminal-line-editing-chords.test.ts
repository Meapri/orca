import { describe, expect, it, vi } from 'vitest'
import {
  encodeTerminalControlLetter,
  resolveTerminalLineEditingChord,
  type TerminalLineEditingChordContext
} from './terminal-line-editing-chords'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

const mac: TerminalLineEditingChordContext = { isMac: true, getKittyKeyboardFlags: () => 0 }
const linux: TerminalLineEditingChordContext = { isMac: false, getKittyKeyboardFlags: () => 0 }

describe('TERMINAL_LINE_EDITING_CHORDS', () => {
  it.each<[string, Partial<TerminalShortcutEvent>, string]>([
    ['Cmd+← line start', { key: 'ArrowLeft', metaKey: true }, '\x01'],
    ['Cmd+→ line end', { key: 'ArrowRight', metaKey: true }, '\x05'],
    ['Cmd+Backspace delete to line start', { key: 'Backspace', metaKey: true }, '\x15'],
    ['Cmd+Fn-Delete delete to line end', { key: 'Delete', metaKey: true }, '\x0b'],
    ['Option+← word left', { key: 'ArrowLeft', altKey: true }, '\x1bb'],
    ['Option+→ word right', { key: 'ArrowRight', altKey: true }, '\x1bf'],
    ['Option+Backspace delete word', { key: 'Backspace', altKey: true }, '\x1b\x7f'],
    ['Option+Fn-Delete delete word forward', { key: 'Delete', altKey: true }, '\x1bd'],
    ['Ctrl+Backspace delete word', { key: 'Backspace', ctrlKey: true }, '\x17']
  ])('maps macOS %s', (_label, overrides, data) => {
    expect(resolveTerminalLineEditingChord(event(overrides), mac)).toEqual({
      type: 'sendInput',
      data
    })
  })

  it.each<[string, Partial<TerminalShortcutEvent>, string]>([
    ['Ctrl+← word left', { key: 'ArrowLeft', ctrlKey: true }, '\x1bb'],
    ['Ctrl+→ word right', { key: 'ArrowRight', ctrlKey: true }, '\x1bf'],
    ['Ctrl+Backspace delete word', { key: 'Backspace', ctrlKey: true }, '\x17'],
    ['Ctrl+Delete delete word forward', { key: 'Delete', ctrlKey: true }, '\x1bd'],
    ['Alt+Delete delete word forward', { key: 'Delete', altKey: true }, '\x1bd']
  ])('maps Linux/Windows %s', (_label, overrides, data) => {
    expect(resolveTerminalLineEditingChord(event(overrides), linux)).toEqual({
      type: 'sendInput',
      data
    })
  })

  it('leaves Home/End, Shift variants, and platform-foreign chords to xterm', () => {
    expect(resolveTerminalLineEditingChord(event({ key: 'Home' }), linux)).toBeNull()
    expect(
      resolveTerminalLineEditingChord(event({ key: 'ArrowLeft', metaKey: true }), linux)
    ).toBeNull()
    expect(
      resolveTerminalLineEditingChord(event({ key: 'ArrowLeft', ctrlKey: true }), mac)
    ).toBeNull()
    expect(resolveTerminalLineEditingChord(event({ key: 'Delete', ctrlKey: true }), mac)).toBeNull()
    expect(
      resolveTerminalLineEditingChord(
        event({ key: 'ArrowLeft', metaKey: true, shiftKey: true }),
        mac
      )
    ).toBeNull()
    expect(
      resolveTerminalLineEditingChord(event({ key: 'Delete', altKey: true, metaKey: true }), mac)
    ).toBeNull()
    expect(
      resolveTerminalLineEditingChord(
        event({ key: 'Delete', code: 'NumpadDecimal', altKey: true }),
        mac
      )
    ).toBeNull()
  })

  it('yields word chords to xterm kitty encoding and PSReadLine-owned chords to ConPTY', () => {
    const kitty = { ...mac, getKittyKeyboardFlags: () => 1 }
    expect(resolveTerminalLineEditingChord(event({ key: 'Delete', altKey: true }), kitty)).toEqual({
      type: 'yield'
    })
    expect(
      resolveTerminalLineEditingChord(event({ key: 'Backspace', altKey: true }), kitty)
    ).toEqual({ type: 'yield' })
    const isLocalWindowsConptyPane = vi.fn(() => true)
    const conpty = { ...linux, isLocalWindowsConptyPane }
    expect(
      resolveTerminalLineEditingChord(event({ key: 'Delete', ctrlKey: true }), conpty)
    ).toEqual({ type: 'yield' })
    expect(
      resolveTerminalLineEditingChord(event({ key: 'Backspace', ctrlKey: true }), conpty)
    ).toEqual({ type: 'sendInput', data: '\x17' })
  })

  it('encodes macOS Cmd line chords as the kitty Ctrl+letter a real press would send', () => {
    const withFlags = (flags: number) => ({ ...mac, getKittyKeyboardFlags: () => flags })
    expect(
      resolveTerminalLineEditingChord(event({ key: 'ArrowLeft', metaKey: true }), withFlags(1))
    ).toEqual({ type: 'sendInput', data: '\x1b[97;5u' })
    expect(
      resolveTerminalLineEditingChord(event({ key: 'Backspace', metaKey: true }), withFlags(3))
    ).toEqual({ type: 'sendInput', data: '\x1b[117;5u\x1b[117;5:3u' })
  })
})

describe('encodeTerminalControlLetter', () => {
  it('sends the C0 byte when the pane has not negotiated kitty text-key encoding', () => {
    expect(encodeTerminalControlLetter('e', 0)).toBe('\x05')
    expect(encodeTerminalControlLetter('k', 0)).toBe('\x0b')
  })

  it('uses CSI-u for disambiguate and report-all panes', () => {
    expect(encodeTerminalControlLetter('e', 1)).toBe('\x1b[101;5u')
    expect(encodeTerminalControlLetter('a', 8)).toBe('\x1b[97;5u')
  })
})

describe('resolveTerminalShortcutAction line editing', () => {
  it('routes Option+Fn-Delete to kill-word instead of the unbound CSI 3;3~ (#21491)', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'Delete', code: 'Delete', altKey: true }), true)
    ).toEqual({ type: 'sendInput', data: '\x1bd' })
  })

  it('does not fall through to Option compose handling after a kitty yield', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Delete', code: 'Delete', altKey: true }),
        true,
        'true',
        0,
        false,
        undefined,
        undefined,
        () => 1
      )
    ).toBeNull()
  })

  it('keeps Cmd+↑/↓ scrolling the viewport', () => {
    expect(resolveTerminalShortcutAction(event({ key: 'ArrowUp', metaKey: true }), true)).toEqual({
      type: 'scrollViewport',
      position: 'top'
    })
  })
})
