import {
  createHeadlessAutomationOutputSnapshotBuffer,
  type HeadlessAutomationDispatcher
} from './headless-dispatch'
import { buildHeadlessAutomationWorktreeCreateArgs } from './headless-workspace-create'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

type AutomationDispatchRuntime = Pick<
  OrcaRuntimeService,
  | 'createManagedWorktree'
  | 'launchAgentTerminal'
  | 'showManagedWorktree'
  | 'waitForTerminal'
  | 'readTerminal'
>

/** Runs a due automation through the runtime alone, for hosts with no renderer (serve, orcad). */
export function createRuntimeHeadlessAutomationDispatcher(
  runtime: AutomationDispatchRuntime
): HeadlessAutomationDispatcher {
  return async ({ automation, run, target }) => {
    const terminalSnapshotLimit = 2_000
    let terminalHandle: string
    let terminalSessionId: string | null = null
    let terminalPaneKey: string | null = null
    let terminalPtyId: string | null = null
    let workspaceId: string
    let workspaceDisplayName: string | null = null
    if (automation.workspaceMode === 'new_per_run') {
      const created = await runtime.createManagedWorktree(
        buildHeadlessAutomationWorktreeCreateArgs({ automation, run, repo: target.repo })
      )
      terminalHandle = created.startupTerminal?.handle ?? ''
      terminalSessionId = created.startupTerminal?.tabId ?? null
      terminalPaneKey = created.startupTerminal?.paneKey ?? null
      terminalPtyId = created.startupTerminal?.ptyId ?? null
      workspaceId = created.worktree.id
      workspaceDisplayName = created.worktree.displayName ?? null
      if (!terminalHandle) {
        throw new Error(
          created.warning || 'Automation workspace was created, but no agent terminal started.'
        )
      }
    } else {
      if (!automation.workspaceId) {
        throw new Error('The target workspace is no longer available.')
      }
      const terminal = await runtime.launchAgentTerminal(`id:${automation.workspaceId}`, {
        agent: automation.agentId,
        prompt: automation.prompt,
        title: run.title
      })
      terminalHandle = terminal.handle
      terminalSessionId = terminal.tabId ?? null
      terminalPaneKey = terminal.paneKey ?? null
      terminalPtyId = terminal.ptyId ?? null
      workspaceId = terminal.worktreeId
      const worktree = await runtime.showManagedWorktree(`id:${workspaceId}`)
      workspaceDisplayName = worktree.displayName ?? null
    }
    const completion = (async () => {
      const wait = await runtime.waitForTerminal(terminalHandle, { condition: 'tui-idle' })
      const read = await runtime.readTerminal(terminalHandle, {
        limit: terminalSnapshotLimit
      })
      const snapshotBuffer = createHeadlessAutomationOutputSnapshotBuffer()
      snapshotBuffer.append(read.tail.join('\n'))
      if (wait.satisfied) {
        return {
          status: 'completed' as const,
          outputSnapshot: snapshotBuffer.snapshot(),
          error: null
        }
      }
      return {
        status: 'dispatch_failed' as const,
        outputSnapshot: snapshotBuffer.snapshot(),
        error: wait.blockedReason
          ? `Automation agent is blocked: ${wait.blockedReason}.`
          : 'Automation agent did not report completion.'
      }
    })()
    return {
      workspaceId,
      workspaceDisplayName,
      terminalSessionId,
      terminalPaneKey,
      terminalPtyId,
      completion
    }
  }
}
