import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import { REMOTE_RUNTIME_SOCKET_PING_PAYLOAD } from './remote-runtime-socket-liveness'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from './remote-runtime-shared-control-test-server'

afterEach(closeSharedControlTestServers)

// Regression for #20673: an empty client probe makes the host auto-pong an empty frame, which an
// unpatched Electron/Linux ARM64 host fails to write (EFAULT), dropping the connection.
describe('shared control liveness ping payload', () => {
  it('probes the host with a non-empty payload', async () => {
    const server = await createSharedControlTestServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      liveness: { pingIntervalMs: 30, livenessTimeoutMs: 1_000 }
    })
    await connection.request('worktree.ps', undefined, 1_000)

    await vi.waitFor(() => expect(server.pingPayloads.length).toBeGreaterThanOrEqual(2))
    for (const payload of server.pingPayloads) {
      expect(new Uint8Array(payload)).toEqual(REMOTE_RUNTIME_SOCKET_PING_PAYLOAD)
    }
    expect(server.connectionCount()).toBe(1)
    connection.close()
  })
})
