import type { AgentStatusClearIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { HeadlessSleepingAgentResume } from '../runtime/headless-sleeping-agent-resume'
import { HeadlessSleepingAgentCapture } from './headless-sleeping-agent-capture'
import type { AgentHookServer } from './server'
import { toAgentStatusIpcPayload } from './server/server-status-identity'

export type HeadlessSleepingAgentStatusSource = Pick<
  AgentHookServer,
  'subscribeEnrichedStatus' | 'subscribePaneStatusClear' | 'getStatusSnapshot'
>

type HeadlessSleepingAgentRuntime = Pick<
  OrcaRuntimeService,
  | 'listLocalSleepingAgentSessions'
  | 'setLocalSleepingAgentSession'
  | 'getAgentLaunchConfigForPane'
  | 'isLocalWorkspace'
  | 'isPaneTerminalConnected'
  | 'isTerminalSurfaceRetired'
  | 'probeSleepingAgentPaneLiveness'
  | 'ensureAgentSession'
  | 'sleepTerminalsForWorktree'
  | 'setHeadlessAgentResumeHost'
>

export type HeadlessSleepingAgentHost = {
  /** Relaunch agents whose PTYs a restart lost; call once the RPC transport is up. */
  resumeAfterRestart(): Promise<void>
  uninstall(): void
}

/** Host-side capture plus cold restore of sleeping agents, for a host with no renderer. */
export function installHeadlessSleepingAgentHost(options: {
  server: HeadlessSleepingAgentStatusSource
  store: Pick<Store, 'getWorktreeIdForTab'>
  runtime: HeadlessSleepingAgentRuntime
}): HeadlessSleepingAgentHost {
  const { server, store, runtime } = options
  const capture = new HeadlessSleepingAgentCapture({
    runtime,
    resolveWorktreeIdForTab: (tabId) => store.getWorktreeIdForTab(tabId)
  })
  const resume = new HeadlessSleepingAgentResume({
    runtime,
    capture,
    readStatusRows: () => server.getStatusSnapshot()
  })
  const unsubscribeStatus = server.subscribeEnrichedStatus((event) => {
    if (!event.isReplay) {
      capture.observeLiveRow(toAgentStatusIpcPayload(event))
    }
  })
  const pendingClears = new Set<ReturnType<typeof setTimeout>>()
  const unsubscribeClear = server.subscribePaneStatusClear((clear: AgentStatusClearIpcPayload) => {
    if (!('paneKey' in clear)) {
      return
    }
    // Why deferred: a PTY exit clears the row before the runtime records that exit, so only
    // after this tick does "is the pane's PTY still connected" tell an agent quit from a lost PTY.
    const timer = setTimeout(() => {
      pendingClears.delete(timer)
      capture.observeRowCleared(clear.paneKey)
    }, 0)
    pendingClears.add(timer)
  })
  runtime.setHeadlessAgentResumeHost(resume)
  return {
    resumeAfterRestart: () => resume.resumeAfterRestart(),
    uninstall: () => {
      runtime.setHeadlessAgentResumeHost(null)
      resume.stop()
      unsubscribeStatus()
      unsubscribeClear()
      for (const timer of pendingClears) {
        clearTimeout(timer)
      }
      pendingClears.clear()
    }
  }
}
