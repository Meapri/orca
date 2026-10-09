import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { PaneManager } from './pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import { applyTerminalAppearance } from '@/components/terminal-pane/terminal-appearance'
import {
  setTerminalCursorAnimationEnabled,
  trackWebglCursorAnimation,
  untrackWebglCursorAnimation
} from './pane-webgl-cursor-animation'

type FakeAddon = WebglAddon & { setCursorAnimation: ReturnType<typeof vi.fn> }

const tracked: WebglAddon[] = []

function trackAddon(): FakeAddon {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only setCursorAnimation is exercised.
  const addon = { setCursorAnimation: vi.fn() } as unknown as FakeAddon
  trackWebglCursorAnimation(addon)
  tracked.push(addon)
  return addon
}

afterEach(() => {
  tracked.splice(0).forEach(untrackWebglCursorAnimation)
  setTerminalCursorAnimationEnabled(false)
})

describe('WebGL cursor animation toggle', () => {
  it('keeps the upstream cursor until the setting is first applied', () => {
    expect(trackAddon().setCursorAnimation).toHaveBeenCalledWith(false)
  })

  it('hands later attaches the current setting', () => {
    setTerminalCursorAnimationEnabled(true)
    expect(trackAddon().setCursorAnimation).toHaveBeenCalledWith(true)
  })

  it('toggles live addons and skips no-op applies', () => {
    const addon = trackAddon()
    setTerminalCursorAnimationEnabled(true)
    setTerminalCursorAnimationEnabled(true)
    expect(addon.setCursorAnimation.mock.calls).toEqual([[false], [true]])
  })

  it('stops reaching disposed addons', () => {
    const addon = trackAddon()
    untrackWebglCursorAnimation(addon)
    setTerminalCursorAnimationEnabled(true)
    expect(addon.setCursorAnimation).toHaveBeenCalledTimes(1)
  })

  it('tolerates an addon without the patched method', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an addon double missing the patched method.
    const unpatched = {} as WebglAddon
    expect(() => trackWebglCursorAnimation(unpatched)).not.toThrow()
    untrackWebglCursorAnimation(unpatched)
  })

  it('follows the terminal appearance setting, on unless explicitly disabled', () => {
    const addon = trackAddon()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a manager without panes only needs these members.
    const manager = { getPanes: () => [], setPaneStyleOptions: vi.fn() } as unknown as PaneManager
    const settings = getDefaultSettings('/tmp')
    const apply = (terminalCursorAnimation: boolean | undefined): void =>
      applyTerminalAppearance(
        manager,
        { ...settings, terminalCursorAnimation },
        true,
        new Map(),
        new Map(),
        'false',
        new Map(),
        new Map()
      )

    expect(settings.terminalCursorAnimation).toBe(true)
    apply(undefined)
    expect(addon.setCursorAnimation).toHaveBeenLastCalledWith(true)
    apply(false)
    expect(addon.setCursorAnimation).toHaveBeenLastCalledWith(false)
  })
})
