import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  getEffectiveKeybindingsForAction
} from '../../../../../shared/keybindings'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from '../terminal-shortcut-policy'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

const arrowUp = { key: 'ArrowUp', code: 'ArrowUp' }
const arrowDown = { key: 'ArrowDown', code: 'ArrowDown' }

describe('prompt navigation and bookmark keybindings', () => {
  it.each([
    ['darwin', 'Mod+Alt'],
    ['linux', 'Mod+Alt'],
    ['win32', 'Mod+Alt']
  ] as const)('adds conflict-free defaults on %s', (platform, modifiers) => {
    expect(getEffectiveKeybindingsForAction('terminal.previousPrompt', platform)).toEqual([
      `${modifiers}+ArrowUp`
    ])
    expect(getEffectiveKeybindingsForAction('terminal.nextPrompt', platform)).toEqual([
      `${modifiers}+ArrowDown`
    ])
    expect(getEffectiveKeybindingsForAction('terminal.toggleBookmark', platform)).toEqual([])
    expect(findKeybindingConflicts(platform)).toEqual([])
  })

  it('reports a conflict when the bookmark chord is remapped onto prompt navigation', () => {
    expect(
      findKeybindingConflicts('linux', { 'terminal.toggleBookmark': ['Mod+Alt+ArrowUp'] })
    ).toContainEqual({
      binding: 'Mod+Alt+ArrowUp',
      actionIds: expect.arrayContaining(['terminal.previousPrompt', 'terminal.toggleBookmark'])
    })
  })

  it('resolves Cmd+Option+Arrow on macOS, including key repeat', () => {
    expect(
      resolveTerminalShortcutAction(event({ ...arrowUp, metaKey: true, altKey: true }), true)
    ).toEqual({ type: 'navigatePrompt', direction: 'previous' })
    expect(
      resolveTerminalShortcutAction(
        event({ ...arrowDown, metaKey: true, altKey: true, repeat: true }),
        true
      )
    ).toEqual({ type: 'navigatePrompt', direction: 'next' })
  })

  it('resolves Ctrl+Alt+Arrow on Linux and Windows', () => {
    const chord = event({ ...arrowUp, ctrlKey: true, altKey: true })
    expect(resolveTerminalShortcutAction(chord, false)).toEqual({
      type: 'navigatePrompt',
      direction: 'previous'
    })
    expect(resolveTerminalShortcutAction(chord, false, 'false', 0, true)).toEqual({
      type: 'navigatePrompt',
      direction: 'previous'
    })
  })

  it('keeps existing arrow behavior: Cmd+↑ scrolls, Ctrl+↑ and Alt+↑ reach the program', () => {
    expect(resolveTerminalShortcutAction(event({ ...arrowUp, metaKey: true }), true)).toEqual({
      type: 'scrollViewport',
      position: 'top'
    })
    expect(resolveTerminalShortcutAction(event({ ...arrowUp, ctrlKey: true }), false)).toBeNull()
    expect(resolveTerminalShortcutAction(event({ ...arrowUp, altKey: true }), false)).toBeNull()
  })

  it('only claims the bookmark chord once the user assigns one', () => {
    const chord = event({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true })
    expect(resolveTerminalShortcutAction(chord, false)).toBeNull()
    expect(
      resolveTerminalShortcutAction(chord, false, 'false', 0, false, {
        'terminal.toggleBookmark': ['Ctrl+Alt+B']
      })
    ).toEqual({ type: 'toggleBookmark' })
  })
})
