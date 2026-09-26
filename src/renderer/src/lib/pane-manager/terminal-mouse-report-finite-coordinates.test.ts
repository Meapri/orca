// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercises the vendored xterm patch for #20983: a detached screen element has
// no computed padding, so report coordinates became NaN and were encoded into
// the PTY as "\x1b[<65;NaN;NaNM".

const terminals: Terminal[] = []

function openTerminal(): { emitted: string[]; terminal: Terminal } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24 })
  terminal.open(container)
  terminals.push(terminal)
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  // SGR mouse encoding with wheel reporting.
  terminal.write('\x1b[?1000h\x1b[?1006h')
  return { emitted, terminal }
}

function readService(owner: unknown, name: string): Record<string, unknown> {
  const service: unknown = Reflect.get(Object(owner), name)
  if (typeof service !== 'object' || service === null) {
    throw new Error(`xterm internal ${name} is unavailable`)
  }
  return Object(service)
}

function triggerMouseReport(terminal: Terminal, col: number, row: number): boolean {
  const mouseService = readService(Reflect.get(terminal, '_core'), '_mouseService')
  const trigger: unknown = Reflect.get(mouseService, '_triggerMouseEvent')
  if (typeof trigger !== 'function') {
    throw new Error('xterm _triggerMouseEvent is unavailable')
  }
  return Boolean(
    Reflect.apply(trigger, mouseService, [
      { col, row, x: 0, y: 0, button: 4, action: 1, ctrl: false, alt: false, shift: false }
    ])
  )
}

function flushWrites(terminal: Terminal): Promise<void> {
  return new Promise((resolve) => terminal.write('', resolve))
}

beforeEach(() => {
  // Why: happy-dom has no 2D canvas; xterm's DOM renderer only needs glyph widths.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's WidthCache only calls measureText on this context.
    { measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D
  )
})

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('xterm mouse report coordinates', () => {
  it('refuses to encode a report with NaN coordinates', async () => {
    const { emitted, terminal } = openTerminal()
    await flushWrites(terminal)

    expect(triggerMouseReport(terminal, Number.NaN, Number.NaN)).toBe(false)
    expect(triggerMouseReport(terminal, 3, Number.NaN)).toBe(false)
    expect(emitted.join('')).not.toContain('NaN')
  })

  it('still encodes an in-range wheel report', async () => {
    const { emitted, terminal } = openTerminal()
    await flushWrites(terminal)

    expect(triggerMouseReport(terminal, 3, 4)).toBe(true)
    expect(emitted).toContain('\x1b[<65;4;5M')
  })

  it('yields no report coordinates for an element without computed padding', () => {
    const { terminal } = openTerminal()
    const core = Reflect.get(terminal, '_core')
    const charSize = readService(core, '_charSizeService')
    // Why: happy-dom cannot measure glyphs; give the service a valid cell size.
    Object.defineProperty(charSize, 'hasValidSize', { configurable: true, value: true })
    const coordsService = readService(core, '_mouseCoordsService')
    const getCoords: unknown = Reflect.get(coordsService, 'getMouseReportCoords')
    if (typeof getCoords !== 'function') {
      throw new Error('xterm getMouseReportCoords is unavailable')
    }
    const detachedLike = {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) }
      }
    }

    expect(
      Reflect.apply(getCoords, coordsService, [{ clientX: 10, clientY: 10 }, detachedLike])
    ).toBeUndefined()
  })
})
