import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('files.open / files.openDiff host editor tab gate', () => {
  it.each([
    ['a mobile client without the capability', [], undefined],
    [
      'a mobile client advertising host editor tabs',
      [SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY],
      { hostEditorTabs: true }
    ]
  ])('gates host-owned tabs on the caller for %s', async (_label, capabilities, expected) => {
    const openMobileFile = vi.fn().mockResolvedValue({ opened: true })
    const openMobileDiff = vi.fn().mockResolvedValue({ opened: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the file-open methods read only these three members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      openMobileFile,
      openMobileDiff
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const options = { clientKind: 'mobile' as const, clientCapabilities: capabilities }

    await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.md' }),
      options
    )
    await dispatcher.dispatch(
      makeRequest('files.openDiff', { worktree: 'id:wt-1', relativePath: 'a.md', staged: false }),
      options
    )

    // Why exact arity: an old client must reach the runtime exactly as before this capability.
    expect(openMobileFile.mock.calls[0]).toEqual(
      expected ? ['id:wt-1', 'a.md', expected] : ['id:wt-1', 'a.md']
    )
    expect(openMobileDiff.mock.calls[0]).toEqual(
      expected ? ['id:wt-1', 'a.md', false, expected] : ['id:wt-1', 'a.md', false]
    )
  })
})
