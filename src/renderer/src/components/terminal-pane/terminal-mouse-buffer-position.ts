import { getTerminalPixelScrollCssOffset } from '@/lib/pane-manager/terminal-pixel-scroll'

type MouseMappedTerminal = {
  element?: {
    querySelector(selectors: string): {
      getBoundingClientRect(): { left: number; top: number; width: number; height: number }
    } | null
  }
  cols: number
  rows: number
  buffer: { active: { viewportY: number } }
}

export function getTerminalBufferPositionForMouseEvent(
  terminal: MouseMappedTerminal,
  event: { clientX: number; clientY: number }
): { x: number; y: number } | null {
  const screenElement = terminal.element?.querySelector('.xterm-screen')
  if (!screenElement || terminal.cols <= 0 || terminal.rows <= 0) {
    return null
  }

  const rect = screenElement.getBoundingClientRect()
  const relativeX = event.clientX - rect.left
  const relativeY = event.clientY - rect.top
  if (relativeX < 0 || relativeY < 0 || relativeX >= rect.width || relativeY >= rect.height) {
    return null
  }

  const cellWidth = rect.width / terminal.cols
  const cellHeight = rect.height / terminal.rows
  if (cellWidth <= 0 || cellHeight <= 0) {
    return null
  }

  // Why: mid pixel-scroll every row is drawn above its cell; clamp like xterm's own mouse coords.
  const drawnY = relativeY + getTerminalPixelScrollCssOffset(terminal)
  const viewportRow = Math.min(Math.floor(drawnY / cellHeight), terminal.rows - 1)
  return {
    x: Math.floor(relativeX / cellWidth) + 1,
    y: viewportRow + terminal.buffer.active.viewportY + 1
  }
}
