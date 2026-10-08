import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PIXEL_SCROLL_SETTLE_DELAY_MS,
  PIXEL_SCROLL_SETTLE_DURATION_MS,
  PixelScrollSettler,
  isPixelScrollActive,
  resolvePixelScrollPosition,
  resolvePixelScrollSettleRow,
  type IPixelScrollGate
} from '@xterm/xterm/src/browser/PixelScroll'
import {
  PIXEL_SCROLL_EXTRA_ROWS,
  writePixelScrollProjection
} from '@xterm/addon-webgl/src/PixelScroll'
import {
  DEFAULT_TERMINAL_PIXEL_SCROLL,
  TERMINAL_PIXEL_SCROLL_SETTLE_MS,
  resolveTerminalPixelScroll
} from './terminal-pixel-scroll'

// The math ships inside Orca's xterm source patches; these tests pin it as installed.

// 17px CSS rows on a 2x display.
const CSS_CELL = 17
const DEVICE_CELL = 34
const MAX_ROW = 400

describe('resolvePixelScrollPosition', () => {
  it('splits a scroll position into the top row and a whole-device-pixel offset', () => {
    expect(resolvePixelScrollPosition(10 * CSS_CELL, CSS_CELL, DEVICE_CELL, MAX_ROW)).toEqual({
      row: 10,
      offset: 0
    })
    expect(resolvePixelScrollPosition(10 * CSS_CELL + 5, CSS_CELL, DEVICE_CELL, MAX_ROW)).toEqual({
      row: 10,
      offset: 10
    })
    // Fractional CSS positions round to a device pixel so glyphs stay on the pixel grid.
    expect(
      resolvePixelScrollPosition(10 * CSS_CELL + 5.3, CSS_CELL, DEVICE_CELL, MAX_ROW).offset
    ).toBe(11)
  })

  it('keeps the partially scrolled-off row as the top row in both directions', () => {
    // Floor, not upstream's round: the row a GUI view would show at the top edge.
    expect(resolvePixelScrollPosition(10 * CSS_CELL + 14, CSS_CELL, DEVICE_CELL, MAX_ROW)).toEqual({
      row: 10,
      offset: 28
    })
  })

  it('snaps offsets within a device pixel and a half of a row edge onto it', () => {
    // A canvas height rounded down can stop the scrollable just short of a row.
    expect(resolvePixelScrollPosition(11 * CSS_CELL - 0.5, CSS_CELL, DEVICE_CELL, MAX_ROW)).toEqual(
      { row: 11, offset: 0 }
    )
    expect(resolvePixelScrollPosition(11 * CSS_CELL + 0.5, CSS_CELL, DEVICE_CELL, MAX_ROW)).toEqual(
      { row: 11, offset: 1 }
    )
  })

  it('never offsets the last page, which has no row below it', () => {
    expect(
      resolvePixelScrollPosition(MAX_ROW * CSS_CELL + 3, CSS_CELL, DEVICE_CELL, MAX_ROW)
    ).toEqual({ row: MAX_ROW, offset: 0 })
    expect(
      resolvePixelScrollPosition(MAX_ROW * CSS_CELL - 0.4, CSS_CELL, DEVICE_CELL, MAX_ROW)
    ).toEqual({ row: MAX_ROW, offset: 0 })
  })

  it('draws whole rows without valid cell metrics', () => {
    expect(resolvePixelScrollPosition(100, 0, DEVICE_CELL, MAX_ROW)).toEqual({
      row: 0,
      offset: 0
    })
    expect(resolvePixelScrollPosition(-20, CSS_CELL, DEVICE_CELL, MAX_ROW)).toEqual({
      row: 0,
      offset: 0
    })
  })
})

describe('resolvePixelScrollSettleRow', () => {
  const at = (rows: number): number => rows * CSS_CELL

  it('continues forward once a quarter of the next row shows, else falls back', () => {
    expect(resolvePixelScrollSettleRow(at(10.3), CSS_CELL, 1, MAX_ROW)).toBe(11)
    expect(resolvePixelScrollSettleRow(at(10.2), CSS_CELL, 1, MAX_ROW)).toBe(10)
    expect(resolvePixelScrollSettleRow(at(10.7), CSS_CELL, -1, MAX_ROW)).toBe(10)
    expect(resolvePixelScrollSettleRow(at(10.8), CSS_CELL, -1, MAX_ROW)).toBe(11)
  })

  it('rounds when the direction is unknown and clamps to the scrollback', () => {
    expect(resolvePixelScrollSettleRow(at(10.4), CSS_CELL, 0, MAX_ROW)).toBe(10)
    expect(resolvePixelScrollSettleRow(at(10.6), CSS_CELL, 0, MAX_ROW)).toBe(11)
    expect(resolvePixelScrollSettleRow(at(MAX_ROW + 0.9), CSS_CELL, 1, MAX_ROW)).toBe(MAX_ROW)
    expect(resolvePixelScrollSettleRow(-5, CSS_CELL, -1, MAX_ROW)).toBe(0)
  })
})

describe('isPixelScrollActive', () => {
  const active: IPixelScrollGate = {
    enabled: true,
    rendererDrawsOffset: true,
    isNormalBuffer: true,
    areMouseEventsActive: false,
    prefersReducedMotion: false
  }

  it('is on only for the normal buffer on an offset-capable renderer', () => {
    expect(isPixelScrollActive(active)).toBe(true)
  })

  it.each([
    ['the option is off', { enabled: false }],
    ['the DOM renderer is active', { rendererDrawsOffset: false }],
    ['the alt screen is active', { isNormalBuffer: false }],
    ['the app requests mouse reports', { areMouseEventsActive: true }],
    ['reduced motion is preferred', { prefersReducedMotion: true }]
  ])('steps whole rows when %s', (_label, change) => {
    expect(isPixelScrollActive({ ...active, ...change })).toBe(false)
  })
})

describe('PixelScrollSettler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles once scroll events stop, reporting their direction', () => {
    const onSettle = vi.fn()
    const settler = new PixelScrollSettler(onSettle)
    settler.noteScroll(100)
    settler.noteScroll(104)
    vi.advanceTimersByTime(PIXEL_SCROLL_SETTLE_DELAY_MS - 1)
    // Momentum keeps delivering events inside the delay, so the settle keeps waiting.
    settler.noteScroll(107)
    vi.advanceTimersByTime(PIXEL_SCROLL_SETTLE_DELAY_MS - 1)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledExactlyOnceWith(1)
    expect(settler.isPending).toBe(false)
  })

  it('reports upward travel and forgets direction between gestures', () => {
    const onSettle = vi.fn()
    const settler = new PixelScrollSettler(onSettle)
    settler.noteScroll(100)
    settler.noteScroll(90)
    vi.advanceTimersByTime(PIXEL_SCROLL_SETTLE_DELAY_MS)
    settler.noteScroll(90)
    vi.advanceTimersByTime(PIXEL_SCROLL_SETTLE_DELAY_MS)
    expect(onSettle.mock.calls).toEqual([[-1], [0]])
  })

  it('never fires after cancel or dispose', () => {
    const onSettle = vi.fn()
    const settler = new PixelScrollSettler(onSettle)
    settler.noteScroll(1)
    settler.cancel()
    settler.noteScroll(2)
    settler.dispose()
    vi.advanceTimersByTime(PIXEL_SCROLL_SETTLE_DELAY_MS * 2)
    expect(onSettle).not.toHaveBeenCalled()
  })
})

describe('writePixelScrollProjection', () => {
  const projection = new Float32Array([2, 0, 0, 0, 0, -2, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1])

  it('moves clip space up by the offset without touching the rest of the matrix', () => {
    const out = writePixelScrollProjection(new Float32Array(16), projection, 10, 400)
    expect(out[13]).toBeCloseTo(1.05)
    expect([...out.slice(0, 13), ...out.slice(14)]).toEqual([
      ...projection.slice(0, 13),
      ...projection.slice(14)
    ])
  })

  it('leaves the projection unchanged at a zero offset', () => {
    expect([...writePixelScrollProjection(new Float32Array(16), projection, 0, 400)]).toEqual([
      ...projection
    ])
  })

  it('keeps one row below the viewport for the offset to reveal', () => {
    expect(PIXEL_SCROLL_EXTRA_ROWS).toBe(1)
  })
})

describe('Orca pixel-scroll setting', () => {
  it('defaults on', () => {
    expect(DEFAULT_TERMINAL_PIXEL_SCROLL).toBe(true)
    expect(resolveTerminalPixelScroll(undefined)).toBe(true)
    expect(resolveTerminalPixelScroll(false)).toBe(false)
  })

  it('waits for the whole xterm settle before sampling scroll intent', () => {
    expect(TERMINAL_PIXEL_SCROLL_SETTLE_MS).toBe(
      PIXEL_SCROLL_SETTLE_DELAY_MS + PIXEL_SCROLL_SETTLE_DURATION_MS
    )
  })
})
