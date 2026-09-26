import { describe, expect, it } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from '../terminal-pane/terminal-shortcut-policy'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: '>',
    code: 'Period',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    ...overrides
  }
}

describe('terminal.openComposer shortcut', () => {
  it('opens on Cmd+Shift+. on macOS and Ctrl+Shift+. elsewhere', () => {
    expect(resolveTerminalShortcutAction(event({ metaKey: true }), true)).toEqual({
      type: 'openComposer'
    })
    expect(resolveTerminalShortcutAction(event({ ctrlKey: true }), false)).toEqual({
      type: 'openComposer'
    })
  })

  it('does not steal the platform-foreign chord or unshifted Cmd+.', () => {
    expect(resolveTerminalShortcutAction(event({ ctrlKey: true }), true)).toBeNull()
    expect(
      resolveTerminalShortcutAction(event({ key: '.', metaKey: true, shiftKey: false }), true)
    ).toBeNull()
  })

  it('follows a user remap and releases the default chord', () => {
    const keybindings = { 'terminal.openComposer': ['Mod+Shift+Y'] }
    expect(
      resolveTerminalShortcutAction(event({ metaKey: true }), true, 'false', 0, false, keybindings)
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Y', code: 'KeyY', metaKey: true }),
        true,
        'false',
        0,
        false,
        keybindings
      )
    ).toEqual({ type: 'openComposer' })
  })
})
