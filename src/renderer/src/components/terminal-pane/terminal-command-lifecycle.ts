import type { Terminal, IDisposable } from '@xterm/xterm'
import { createOsc133CommandFinishedScanner } from '../../../../shared/terminal-osc133-command-finished'
import { observeTerminalShellIntegrationMark } from './terminal-shell-input-anchor'

type TerminalCommandLifecycleOptions = {
  onCommandFinished: (bestEffortExitCode: number | null) => void
  /** OSC 133;C — the shell exec'd a command; the pane's foreground changed. */
  onCommandStarted?: () => void
}

export function createTerminalCommandLifecycle(options: TerminalCommandLifecycleOptions): {
  handlePtyData: (data: string) => void
  attachXtermConsumer: (terminal: Terminal) => IDisposable
  dispose: () => void
} {
  // Why: the byte parsing lives in shared so main's side-effect tracker emits
  // identical command-finished facts for local/SSH PTYs; this renderer wrapper
  // remains the byte path for remote-runtime PTYs and the kill-switch-off mode.
  const scanner = createOsc133CommandFinishedScanner(
    options.onCommandFinished,
    options.onCommandStarted
  )
  const disposables: IDisposable[] = []

  return {
    handlePtyData: scanner.scan,
    attachXtermConsumer(terminal) {
      // Why: swallow OSC 133 so shell-integration markers never paint —
      // rendering hygiene that applies regardless of side-effect authority.
      // The mark still feeds the prompt-input anchor click-to-move relies on.
      const disposable = terminal.parser.registerOscHandler(133, (data) => {
        try {
          observeTerminalShellIntegrationMark(terminal, data)
        } catch {
          // Why: the anchor is best-effort; a throw here must not unswallow the mark.
        }
        return true
      })
      disposables.push(disposable)
      return disposable
    },
    dispose() {
      scanner.reset()
      for (const disposable of disposables.splice(0)) {
        disposable.dispose()
      }
    }
  }
}
