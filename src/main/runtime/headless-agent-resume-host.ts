import type { TerminalExitCause } from '../../shared/terminal-exit-cause'

export type HeadlessAgentResumeTerminalExit = {
  paneKeys: readonly string[]
  cause: TerminalExitCause
  /** Settles once the host has retired the exited surfaces, so a resume never races it. */
  retirement: Promise<void> | undefined
}

/**
 * What a renderer-less host installs to capture and resume sleeping agents
 * (docs/reference/orcad-feature-parity.md). The runtime calls it only where a desktop
 * renderer would otherwise have done the work.
 */
export type HeadlessAgentResumeHost = {
  observeTerminalExit(exit: HeadlessAgentResumeTerminalExit): void
  sleepWorktree(worktreeId: string): Promise<void>
  /** Resumes the worktree's slept agents; false when it holds none to resume. */
  wakeWorktree(worktreeId: string): boolean
}
