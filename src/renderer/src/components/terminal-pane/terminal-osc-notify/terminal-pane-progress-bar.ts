import type { IDisposable } from '@xterm/xterm'
import { getTerminalPaneProgress, subscribeTerminalProgress } from './terminal-progress-store'

export const TERMINAL_PROGRESS_BAR_CLASS = 'orca-terminal-progress'

/**
 * Thin OSC 9;4 bar along the pane's top edge. Plain DOM because the `.pane`
 * element is owned by PaneManager, not React; styling lives in terminal.css.
 */
export function installTerminalPaneProgressBar(
  container: HTMLElement,
  paneKey: string
): IDisposable {
  let root: HTMLDivElement | null = null
  let fill: HTMLDivElement | null = null

  const render = (): void => {
    const progress = getTerminalPaneProgress(paneKey)
    if (!progress) {
      root?.remove()
      root = null
      fill = null
      return
    }
    if (!root || !fill) {
      root = document.createElement('div')
      root.className = TERMINAL_PROGRESS_BAR_CLASS
      root.setAttribute('role', 'progressbar')
      root.setAttribute('aria-valuemin', '0')
      root.setAttribute('aria-valuemax', '100')
      fill = document.createElement('div')
      fill.className = `${TERMINAL_PROGRESS_BAR_CLASS}-fill`
      root.appendChild(fill)
      container.appendChild(root)
    }
    root.dataset.state = progress.state
    if (progress.percent === null) {
      root.removeAttribute('aria-valuenow')
      fill.style.removeProperty('width')
    } else {
      root.setAttribute('aria-valuenow', String(progress.percent))
      fill.style.width = `${progress.percent}%`
    }
  }

  const unsubscribe = subscribeTerminalProgress(render)
  render()
  return {
    dispose: () => {
      unsubscribe()
      root?.remove()
      root = null
      fill = null
    }
  }
}
