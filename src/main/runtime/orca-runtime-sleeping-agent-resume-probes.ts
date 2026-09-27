import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import type {
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import { copySleepingAgentLaunchConfig } from '../../shared/sleeping-agent-session-record'
import { parsePaneKey } from '../../shared/stable-pane-id'

export type SleepingAgentPaneLiveness = {
  status: PtyLivenessVerdict['status']
  /** The pane is still a surface of the host's persisted workspace session. */
  surfacePersisted: boolean
}

/** Host reads a renderer-less sleeping-agent capture and cold restore need (headless-agent-resume-host.ts). */
export class OrcaRuntimeWithSleepingAgentResumeProbes extends OrcaRuntimeWithResolveWaiter {
  /** Resume records in this host's own partition, where the renderer would have written them. */
  listLocalSleepingAgentSessions(): SleepingAgentSessionRecord[] {
    const session = this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)
    return Object.values(session?.sleepingAgentSessionsByPaneKey ?? {})
  }

  isLocalWorkspace(worktreeId: string): boolean {
    return this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId) === LOCAL_EXECUTION_HOST_ID
  }

  /** Writes one pane's record, or removes it with null. */
  setLocalSleepingAgentSession(paneKey: string, record: SleepingAgentSessionRecord | null): void {
    const store = this.store
    const session = store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)
    if (!store?.setWorkspaceSession || !session) {
      return
    }
    const records = { ...session.sleepingAgentSessionsByPaneKey }
    if (record) {
      records[paneKey] = record
    } else if (paneKey in records) {
      delete records[paneKey]
    } else {
      return
    }
    store.setWorkspaceSession(
      { ...session, sleepingAgentSessionsByPaneKey: records },
      LOCAL_EXECUTION_HOST_ID
    )
  }

  getAgentLaunchConfigForPane(paneKey: string): SleepingAgentLaunchConfig | undefined {
    const launchConfig = this.getPtyRecordForPaneKey(paneKey)?.launchConfig
    return launchConfig ? copySleepingAgentLaunchConfig(launchConfig) : undefined
  }

  isPaneTerminalConnected(paneKey: string): boolean {
    const pty = this.getPtyRecordForPaneKey(paneKey)
    return pty?.connected === true && !this.isPtyKnownExited(pty.ptyId)
  }

  isTerminalSurfaceRetired(tabId: string, leafId: string): boolean {
    return this.closedTerminalSurfaceLedger.findRetiredSurface(tabId, leafId) !== null
  }

  /** Grades the pane's last PTY from the owning provider's inventory, never from lost contact. */
  async probeSleepingAgentPaneLiveness(
    worktreeId: string,
    paneKey: string
  ): Promise<SleepingAgentPaneLiveness> {
    const pane = parsePaneKey(paneKey)
    const layout = pane
      ? this.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId?.[pane.tabId]
      : undefined
    const recordedPtyId = pane ? (layout?.ptyIdsByLeafId?.[pane.leafId] ?? null) : null
    const surfacePersisted = recordedPtyId !== null
    if (this.isPaneTerminalConnected(paneKey)) {
      return { status: 'live', surfacePersisted }
    }
    const runtimePty = this.getPtyRecordForPaneKey(paneKey)
    const inventory = await this.refreshMobileSessionPtyInventory(worktreeId)
    if (!inventory?.queriedHostIds.has(LOCAL_EXECUTION_HOST_ID)) {
      return { status: 'unverifiable', surfacePersisted }
    }
    for (const ptyId of [recordedPtyId, runtimePty?.ptyId ?? null]) {
      if (!ptyId) {
        continue
      }
      if (inventory.allLivePtyIds.has(ptyId)) {
        return { status: 'live', surfacePersisted }
      }
      if (this.getPtyLivenessVerdict(ptyId)?.status === 'unverifiable') {
        return { status: 'unverifiable', surfacePersisted }
      }
    }
    return { status: 'exited', surfacePersisted }
  }
}
