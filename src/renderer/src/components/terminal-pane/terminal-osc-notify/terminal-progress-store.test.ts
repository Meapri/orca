import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_PROGRESS_STALE_MS,
  applyTerminalPaneProgress,
  clearTerminalPaneProgress,
  getTerminalPaneProgress,
  getTerminalTabProgress,
  subscribeTerminalProgress
} from './terminal-progress-store'

const panes = ['tab-1:a', 'tab-1:b', 'tab-2:a']

describe('terminal progress store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    for (const pane of panes) {
      clearTerminalPaneProgress(pane)
    }
    vi.useRealTimers()
  })

  it('sets, updates and clears pane progress, notifying only on change', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalProgress(listener)
    applyTerminalPaneProgress('tab-1:a', 'tab-1', { kind: 'set', state: 'normal', percent: 10 })
    applyTerminalPaneProgress('tab-1:a', 'tab-1', { kind: 'set', state: 'normal', percent: 10 })
    expect(listener).toHaveBeenCalledTimes(1)
    applyTerminalPaneProgress('tab-1:a', 'tab-1', { kind: 'set', state: 'normal', percent: 60 })
    expect(getTerminalPaneProgress('tab-1:a')?.percent).toBe(60)
    applyTerminalPaneProgress('tab-1:a', 'tab-1', { kind: 'clear' })
    expect(getTerminalPaneProgress('tab-1:a')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
  })

  it('keeps the previous percent when error/paused omit it', () => {
    applyTerminalPaneProgress('tab-1:a', 'tab-1', { kind: 'set', state: 'normal', percent: 70 })
    applyTerminalPaneProgress('tab-1:a', 'tab-1', { kind: 'set', state: 'error', percent: null })
    expect(getTerminalPaneProgress('tab-1:a')).toEqual({
      tabId: 'tab-1',
      state: 'error',
      percent: 70
    })
  })

  it('expires a bar whose program stopped reporting', () => {
    applyTerminalPaneProgress('tab-1:a', 'tab-1', { kind: 'set', state: 'normal', percent: 5 })
    vi.advanceTimersByTime(TERMINAL_PROGRESS_STALE_MS - 1)
    applyTerminalPaneProgress('tab-1:a', 'tab-1', { kind: 'set', state: 'normal', percent: 6 })
    vi.advanceTimersByTime(TERMINAL_PROGRESS_STALE_MS - 1)
    expect(getTerminalPaneProgress('tab-1:a')).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(getTerminalPaneProgress('tab-1:a')).toBeNull()
  })

  it('summarizes a tab by its most urgent pane, then its least-complete percent', () => {
    applyTerminalPaneProgress('tab-1:a', 'tab-1', { kind: 'set', state: 'normal', percent: 80 })
    applyTerminalPaneProgress('tab-1:b', 'tab-1', { kind: 'set', state: 'normal', percent: 20 })
    applyTerminalPaneProgress('tab-2:a', 'tab-2', { kind: 'set', state: 'error', percent: 5 })
    expect(getTerminalTabProgress('tab-1')?.percent).toBe(20)
    applyTerminalPaneProgress('tab-1:a', 'tab-1', { kind: 'set', state: 'error', percent: 90 })
    expect(getTerminalTabProgress('tab-1')).toMatchObject({ state: 'error', percent: 90 })
    expect(getTerminalTabProgress('tab-3')).toBeNull()
  })
})
