import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Terminal } from '@xterm/xterm'
import { ArrowDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  markTerminalFollowOutput,
  syncTerminalScrollIntentFromViewport
} from '@/lib/pane-manager/terminal-scroll-intent'
import { smoothScrollTerminalTo } from '@/lib/pane-manager/terminal-smooth-scroll'
import {
  HIDDEN_JUMP_TO_LATEST_VIEW,
  trackTerminalJumpToLatest,
  type TerminalJumpToLatestView
} from './terminal-jump-to-latest-tracker'
import type { TerminalPaneController } from './use-terminal-pane-controller'

function jumpTerminalToLatest(terminal: Terminal): void {
  markTerminalFollowOutput(terminal)
  if (!smoothScrollTerminalTo(terminal, 'bottom')) {
    terminal.scrollToBottom()
    syncTerminalScrollIntentFromViewport(terminal)
  }
  terminal.focus()
}

function TerminalJumpToLatestButton({
  terminal
}: {
  terminal: Terminal
}): React.JSX.Element | null {
  const [view, setView] = useState<TerminalJumpToLatestView>(HIDDEN_JUMP_TO_LATEST_VIEW)
  useEffect(() => {
    const tracker = trackTerminalJumpToLatest(terminal, setView)
    return () => tracker.dispose()
  }, [terminal])
  if (!view.visible) {
    return null
  }
  const label = view.hasNewOutput
    ? translate('components.terminal-pane.jumpToLatest.newOutput', 'New output')
    : translate('components.terminal-pane.jumpToLatest.label', 'Jump to latest')
  return (
    <button
      type="button"
      // Why: keep keyboard focus in the terminal while the pill is clicked.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => jumpTerminalToLatest(terminal)}
      aria-label={translate('components.terminal-pane.jumpToLatest.label', 'Jump to latest')}
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowDown className="size-3.5" />
      <span>{label}</span>
    </button>
  )
}

/** "Jump to latest" pill for a terminal whose reader has scrolled up, mirroring native chat's. */
export function TerminalPaneJumpToLatestPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const { chatLeafId, effectiveChatViewMode, isVisible, managedPanes } = controller
  if (!isVisible) {
    return null
  }
  return (
    <>
      {managedPanes.map((pane) => {
        if (effectiveChatViewMode && pane.leafId === chatLeafId) {
          return null
        }
        return createPortal(
          <TerminalJumpToLatestButton terminal={pane.terminal} />,
          pane.container,
          `jump-to-latest-${pane.id}`
        )
      })}
    </>
  )
}
