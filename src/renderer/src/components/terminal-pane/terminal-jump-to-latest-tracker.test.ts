import type { IEvent } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import {
  resolveTerminalJumpToLatestView,
  trackTerminalJumpToLatest,
  type TerminalJumpToLatestTarget,
  type TerminalJumpToLatestView
} from './terminal-jump-to-latest-tracker'

function createEmitter<T>(): { event: IEvent<T>; fire: (value: T) => void } {
  const listeners = new Set<(value: T) => unknown>()
  return {
    event: (listener) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fire: (value) => {
      for (const listener of listeners) {
        listener(value)
      }
    }
  }
}

function createTerminal() {
  const scroll = createEmitter<number>()
  const lineFeed = createEmitter<void>()
  const resize = createEmitter<unknown>()
  const bufferChange = createEmitter<unknown>()
  const terminal: TerminalJumpToLatestTarget = {
    rows: 10,
    buffer: {
      active: { type: 'normal', viewportY: 100, baseY: 100 },
      onBufferChange: bufferChange.event
    },
    onScroll: scroll.event,
    onLineFeed: lineFeed.event,
    onResize: resize.event
  }
  return { terminal, scroll, lineFeed, bufferChange }
}

describe('resolveTerminalJumpToLatestView', () => {
  it('stays hidden at the bottom and in the alternate screen', () => {
    expect(
      resolveTerminalJumpToLatestView({ type: 'normal', viewportY: 5, baseY: 5 }, 10, true)
    ).toEqual({ visible: false, hasNewOutput: false })
    expect(
      resolveTerminalJumpToLatestView({ type: 'alternate', viewportY: 0, baseY: 50 }, 10, true)
    ).toEqual({ visible: false, hasNewOutput: false })
  })

  it('waits for a full screen of distance unless new output arrived', () => {
    const buffer = { type: 'normal', viewportY: 95, baseY: 100 }
    expect(resolveTerminalJumpToLatestView(buffer, 10, false).visible).toBe(false)
    expect(resolveTerminalJumpToLatestView(buffer, 10, true).visible).toBe(true)
    expect(resolveTerminalJumpToLatestView({ ...buffer, viewportY: 90 }, 10, false).visible).toBe(
      true
    )
  })
})

describe('trackTerminalJumpToLatest', () => {
  it('publishes only transitions and flags output that lands below a reader', () => {
    const { terminal, scroll, lineFeed } = createTerminal()
    const views: TerminalJumpToLatestView[] = []
    const tracker = trackTerminalJumpToLatest(terminal, (view) => views.push(view))

    // Following output: line feeds and scrolls never publish.
    lineFeed.fire(undefined)
    terminal.buffer.active.baseY = 101
    terminal.buffer.active.viewportY = 101
    scroll.fire(0)
    expect(views).toEqual([])

    terminal.buffer.active.viewportY = 97
    scroll.fire(0)
    expect(views).toEqual([])

    lineFeed.fire(undefined)
    lineFeed.fire(undefined)
    expect(views).toEqual([{ visible: true, hasNewOutput: true }])

    terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    scroll.fire(0)
    expect(views.at(-1)).toEqual({ visible: false, hasNewOutput: false })

    tracker.dispose()
    terminal.buffer.active.viewportY = 0
    scroll.fire(0)
    expect(views).toHaveLength(2)
  })

  it('clears the new-output flag when the alternate screen takes over', () => {
    const { terminal, lineFeed, bufferChange } = createTerminal()
    const views: TerminalJumpToLatestView[] = []
    trackTerminalJumpToLatest(terminal, (view) => views.push(view))
    terminal.buffer.active.viewportY = 99
    lineFeed.fire(undefined)

    terminal.buffer.active.type = 'alternate'
    bufferChange.fire(null)
    terminal.buffer.active.type = 'normal'
    bufferChange.fire(null)

    expect(views).toEqual([
      { visible: true, hasNewOutput: true },
      { visible: false, hasNewOutput: false }
    ])
  })
})
