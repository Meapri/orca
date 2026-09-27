// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { attachTerminalMouseWheelMultiplier } from './pane-terminal-mouse-wheel'

// #20983: replayed TUI wheel reports must never carry coordinates xterm would
// encode as NaN into the PTY.

function attachReplay(): {
  element: HTMLElement
  handler: (event: WheelEvent) => boolean
  dispatched: WheelEvent[]
} {
  const element = document.createElement('div')
  element.className = 'enable-mouse-events'
  document.body.appendChild(element)
  const dispatched: WheelEvent[] = []
  element.addEventListener('wheel', (event) => dispatched.push(event))
  let handler: ((event: WheelEvent) => boolean) | null = null
  attachTerminalMouseWheelMultiplier({
    attachCustomWheelEventHandler: (next) => {
      handler = next
    },
    element,
    modes: { mouseTrackingMode: 'any' },
    rows: 24
  })
  if (!handler) {
    throw new Error('wheel handler was not attached')
  }
  return { element, handler, dispatched }
}

function lineTick(clientX = 10): WheelEvent {
  const event = new WheelEvent('wheel', { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: 1 })
  Object.defineProperty(event, 'clientX', { value: clientX })
  Object.defineProperty(event, 'clientY', { value: 10 })
  return event
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('TUI wheel replay guard', () => {
  it('drops replayed reports whose pointer coordinates are not finite', async () => {
    const { handler, dispatched } = attachReplay()

    expect(handler(lineTick(Number.NaN))).toBe(false)
    await Promise.resolve()
    expect(dispatched).toHaveLength(0)

    expect(handler(lineTick())).toBe(false)
    await Promise.resolve()
    expect(dispatched).toHaveLength(1)
  })

  it('drops replayed reports once the terminal element is detached', async () => {
    const { element, handler, dispatched } = attachReplay()

    expect(handler(lineTick())).toBe(false)
    element.remove()
    await Promise.resolve()
    expect(dispatched).toHaveLength(0)

    document.body.appendChild(element)
    expect(handler(lineTick())).toBe(false)
    await Promise.resolve()
    expect(dispatched).toHaveLength(1)
  })
})
