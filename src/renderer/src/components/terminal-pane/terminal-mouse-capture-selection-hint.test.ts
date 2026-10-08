// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastInfo = vi.fn()
vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

const { installTerminalMouseCaptureSelectionHint, resetTerminalMouseCaptureSelectionHint } =
  await import('./terminal-mouse-capture-selection-hint')

type TrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any'

function makeTerminal(mode: TrackingMode) {
  const element = document.createElement('div')
  const modes: { mouseTrackingMode: TrackingMode } = { mouseTrackingMode: mode }
  return { element, modes }
}

function drag(element: HTMLElement, init: MouseEventInit = {}, distance = 40): void {
  element.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 0, clientY: 0, ...init }))
  element.dispatchEvent(
    new MouseEvent('mousemove', { buttons: 1, clientX: distance, clientY: 0, ...init })
  )
  element.dispatchEvent(new MouseEvent('mouseup', { button: 0, ...init }))
}

describe('installTerminalMouseCaptureSelectionHint', () => {
  beforeEach(() => {
    toastInfo.mockClear()
    resetTerminalMouseCaptureSelectionHint()
  })

  it('names Option on macOS and shows only once per session', () => {
    const terminal = makeTerminal('drag')
    const hint = installTerminalMouseCaptureSelectionHint(terminal, true)
    drag(terminal.element)
    drag(terminal.element)
    expect(toastInfo).toHaveBeenCalledTimes(1)
    expect(toastInfo.mock.calls[0][0]).toContain('Option')
    hint.dispose()
  })

  it('names Shift on Windows and Linux', () => {
    const terminal = makeTerminal('any')
    installTerminalMouseCaptureSelectionHint(terminal, false)
    drag(terminal.element)
    expect(toastInfo.mock.calls[0][0]).toContain('Shift')
  })

  it('stays quiet without mouse capture, with the forcing modifier, or for a click', () => {
    const plain = makeTerminal('none')
    installTerminalMouseCaptureSelectionHint(plain, true)
    drag(plain.element)
    const captured = makeTerminal('drag')
    installTerminalMouseCaptureSelectionHint(captured, true)
    drag(captured.element, { altKey: true })
    drag(captured.element, {}, 4)
    expect(toastInfo).not.toHaveBeenCalled()
  })
})
