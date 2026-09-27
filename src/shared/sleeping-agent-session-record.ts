import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from './agent-session-resume'
import type { AgentStatusState } from './agent-status-types'

export function copySleepingAgentLaunchConfig(
  config: SleepingAgentLaunchConfig
): SleepingAgentLaunchConfig {
  return {
    ...(config.agentCommand ? { agentCommand: config.agentCommand } : {}),
    agentArgs: config.agentArgs,
    agentEnv: { ...config.agentEnv },
    ...(config.ompResumeFilePath ? { ompResumeFilePath: config.ompResumeFilePath } : {})
  }
}

/** The agent-status facts a resume record is built from; the renderer and headless hosts both have them. */
export type SleepingAgentRecordSource = {
  paneKey: string
  agentType?: string
  providerSession?: AgentProviderSessionMetadata
  connectionId?: string | null
  prompt: string
  state: AgentStatusState
  updatedAt: number
  terminalTitle?: string
  lastAssistantMessage?: string
  interrupted?: boolean
  terminalResumeEligible?: false
}

/** One record format for every capture site, so any cold restore can read what another wrote. */
export function buildSleepingAgentSessionRecord(args: {
  source: SleepingAgentRecordSource
  worktreeId: string
  tabId?: string
  tabTitle?: string
  capturedAt: number
  launchConfig?: SleepingAgentLaunchConfig
  origin?: SleepingAgentSessionRecord['origin']
}): SleepingAgentSessionRecord | null {
  const { source } = args
  const agent = source.agentType
  if (
    source.terminalResumeEligible === false ||
    !isResumableTuiAgent(agent) ||
    !source.providerSession ||
    !getAgentResumeArgv(agent, source.providerSession)
  ) {
    return null
  }
  const terminalTitle = source.terminalTitle ?? args.tabTitle
  return {
    paneKey: source.paneKey,
    ...(args.tabId ? { tabId: args.tabId } : {}),
    worktreeId: args.worktreeId,
    agent,
    providerSession: source.providerSession,
    ...(source.connectionId !== undefined ? { connectionId: source.connectionId } : {}),
    prompt: source.prompt,
    state: source.state,
    capturedAt: args.capturedAt,
    updatedAt: source.updatedAt,
    ...(terminalTitle ? { terminalTitle } : {}),
    ...(source.lastAssistantMessage ? { lastAssistantMessage: source.lastAssistantMessage } : {}),
    ...(args.launchConfig
      ? { launchConfig: copySleepingAgentLaunchConfig(args.launchConfig) }
      : {}),
    ...(source.interrupted ? { interrupted: true } : {}),
    ...(args.origin ? { origin: args.origin } : {})
  }
}
