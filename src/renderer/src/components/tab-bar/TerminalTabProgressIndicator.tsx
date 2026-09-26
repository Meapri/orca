import { useTerminalTabProgress } from '../terminal-pane/terminal-osc-notify/terminal-progress-store'

/** OSC 9;4 progress along the tab's top edge (the bottom edge is the active-tab indicator). */
export function TerminalTabProgressIndicator({
  tabId
}: {
  tabId: string
}): React.JSX.Element | null {
  const progress = useTerminalTabProgress(tabId)
  if (!progress) {
    return null
  }
  return (
    <span aria-hidden className="orca-terminal-progress" data-state={progress.state}>
      <span
        className="orca-terminal-progress-fill"
        style={progress.percent === null ? undefined : { width: `${progress.percent}%` }}
      />
    </span>
  )
}
