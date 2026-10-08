import { describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../core'
import { TERMINAL_METHODS } from './terminal'

const RESUME_PARAMS = {
  worktree: 'id:worktree-1',
  clientMutationId: 'mutation-1',
  command: "claude '--resume' 'session-1'",
  launchAgent: 'claude',
  resumeProviderSession: { key: 'session_id', id: 'session-1' },
  tabId: 'tab-client-b',
  leafId: '11111111-1111-4111-8111-111111111111'
}

async function createWith(held: boolean) {
  const createTerminal = vi.fn(
    async (_worktree: string | undefined, _options: Record<string, unknown>) => ({
      handle: 't',
      worktreeId: 'worktree-1',
      title: null
    })
  )
  const isAgentResumeHeldByAnotherPane = vi.fn(async () => held)
  const method = eraseRpcMethods(TERMINAL_METHODS).find(
    (candidate) => candidate.name === 'terminal.create'
  )
  if (!method) {
    throw new Error('terminal.create method missing')
  }
  const runtime = {
    createTerminal,
    isAgentResumeHeldByAnotherPane,
    dedupeTerminalCreate: async (
      _client: string,
      _worktree: string | undefined,
      _mutation: string | undefined,
      _reconcile: boolean,
      run: (worktree: string | undefined, handle: string | undefined) => Promise<unknown>
    ) => run('id:worktree-1', 'term_stable')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these members.
  const context = { runtime, pairedDeviceId: 'device-b' } as unknown as RpcContext
  await method.handler(RESUME_PARAMS, context, vi.fn())
  return { createTerminal, isAgentResumeHeldByAnotherPane }
}

describe('legacy terminal.create resume of a session another pane holds', () => {
  it('opens a plain shell at the requested pane instead of a second --resume', async () => {
    const { createTerminal } = await createWith(true)
    const options = createTerminal.mock.calls[0]?.[1]
    expect(options).toMatchObject({ tabId: 'tab-client-b', preAllocatedHandle: 'term_stable' })
    expect(options).not.toHaveProperty('command', RESUME_PARAMS.command)
    expect(options).not.toHaveProperty('resumeProviderSession')
    expect(options).not.toHaveProperty('launchAgent')
  })

  it('passes the resume through when no other pane holds the session', async () => {
    const { createTerminal, isAgentResumeHeldByAnotherPane } = await createWith(false)
    expect(isAgentResumeHeldByAnotherPane).toHaveBeenCalledWith(
      'id:worktree-1',
      expect.objectContaining({ launchAgent: 'claude' })
    )
    expect(createTerminal.mock.calls[0]?.[1]).toMatchObject({
      command: RESUME_PARAMS.command,
      launchAgent: 'claude',
      resumeProviderSession: RESUME_PARAMS.resumeProviderSession
    })
  })
})
