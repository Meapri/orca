import type { IDisposable, Terminal } from '@xterm/xterm'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isMacPlatform } from './terminal-link-open-hints'

type HintTerminal = Pick<Terminal, 'element'> & {
  modes: Pick<Terminal['modes'], 'mouseTrackingMode'>
}

// Why ~2 cells: a click that jitters is not an attempt to select.
const DRAG_THRESHOLD_PX = 16

let hintShown = false

/** Test seam: the hint is once per app session. */
export function resetTerminalMouseCaptureSelectionHint(): void {
  hintShown = false
}

function forcesSelection(event: MouseEvent, isMac: boolean): boolean {
  // Mirrors xterm's SelectionService.shouldForceSelection with macOptionClickForcesSelection.
  return isMac ? event.altKey : event.shiftKey
}

function showHint(isMac: boolean): void {
  hintShown = true
  toast.info(
    isMac
      ? translate(
          'components.terminalPane.mouseCaptureSelectionHint.mac',
          'This app captures the mouse. Hold ⌥ Option while dragging to select text.'
        )
      : translate(
          'components.terminalPane.mouseCaptureSelectionHint.other',
          'This app captures the mouse. Hold Shift while dragging to select text.'
        ),
    { duration: 6000 }
  )
}

/**
 * Once per session, tells a user dragging over a mouse-reporting TUI (vim,
 * tmux, agent CLIs) which modifier makes xterm select text instead.
 */
export function installTerminalMouseCaptureSelectionHint(
  terminal: HintTerminal,
  isMac = isMacPlatform()
): IDisposable {
  const element = terminal.element
  if (!element) {
    return { dispose: () => {} }
  }
  let origin: { x: number; y: number } | null = null
  const onMouseMove = (event: MouseEvent): void => {
    if (!origin || hintShown || (event.buttons & 1) === 0) {
      return
    }
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= DRAG_THRESHOLD_PX) {
      origin = null
      showHint(isMac)
    }
  }
  const onMouseDown = (event: MouseEvent): void => {
    origin =
      !hintShown &&
      event.button === 0 &&
      !forcesSelection(event, isMac) &&
      terminal.modes.mouseTrackingMode !== 'none'
        ? { x: event.clientX, y: event.clientY }
        : null
  }
  const onMouseUp = (): void => {
    origin = null
  }
  element.addEventListener('mousedown', onMouseDown, { capture: true, passive: true })
  element.addEventListener('mousemove', onMouseMove, { capture: true, passive: true })
  element.addEventListener('mouseup', onMouseUp, { capture: true, passive: true })
  return {
    dispose: () => {
      element.removeEventListener('mousedown', onMouseDown, { capture: true })
      element.removeEventListener('mousemove', onMouseMove, { capture: true })
      element.removeEventListener('mouseup', onMouseUp, { capture: true })
    }
  }
}
