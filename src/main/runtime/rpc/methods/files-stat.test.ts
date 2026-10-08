import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('files.stat', () => {
  it('stats a relative path for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      statRuntimeFile: vi.fn().mockResolvedValue({ size: 12, isDirectory: false, mtime: 1 })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.stat', { worktree: 'id:wt-1', relativePath: 'readme.md' })
    )

    expect(runtime.statRuntimeFile).toHaveBeenCalledWith('id:wt-1', 'readme.md')
    expect(response).toMatchObject({ ok: true, result: { isDirectory: false } })
  })
})
