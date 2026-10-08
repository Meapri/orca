export const OPEN_TERMINAL_COMPOSER_EVENT = 'orca:open-terminal-composer'

export type OpenTerminalComposerDetail = {
  tabId: string
  paneId: number
}

export function requestTerminalComposerOpen(detail: OpenTerminalComposerDetail): void {
  window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_COMPOSER_EVENT, { detail }))
}

export function readOpenTerminalComposerDetail(event: Event): OpenTerminalComposerDetail | null {
  if (!(event instanceof CustomEvent)) {
    return null
  }
  const detail: unknown = event.detail
  if (
    typeof detail !== 'object' ||
    detail === null ||
    !('tabId' in detail) ||
    !('paneId' in detail) ||
    typeof detail.tabId !== 'string' ||
    typeof detail.paneId !== 'number'
  ) {
    return null
  }
  return { tabId: detail.tabId, paneId: detail.paneId }
}
