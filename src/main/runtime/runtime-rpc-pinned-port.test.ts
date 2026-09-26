import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { WebSocketPinnedPortUnavailableError } from './rpc/ws-transport-port-binding'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const holders: Server[] = []
const servers: OrcaRuntimeRpcServer[] = []

async function occupyLoopbackPort(): Promise<number> {
  const holder = createServer()
  holders.push(holder)
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
  const address = holder.address()
  if (!address || typeof address !== 'object') {
    throw new Error('holder did not bind')
  }
  return address.port
}

function createServerOn(
  port: number,
  requirePinnedWsPort: boolean
): { server: OrcaRuntimeRpcServer; userDataPath: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-pinned-port-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: port,
    preferPinnedWsPort: true,
    requirePinnedWsPort,
    pinnedBindHost: '127.0.0.1'
  })
  servers.push(server)
  return { server, userDataPath }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop().catch(() => {})))
  await Promise.all(
    holders.splice(0).map((holder) => new Promise<void>((resolve) => holder.close(() => resolve())))
  )
})

describe('pinned WebSocket port', () => {
  it('refuses to start and releases the local socket when a required pin is taken', async () => {
    const port = await occupyLoopbackPort()
    const { server, userDataPath } = createServerOn(port, true)

    await expect(server.start()).rejects.toBeInstanceOf(WebSocketPinnedPortUnavailableError)

    expect(existsSync(getRuntimeMetadataPath(userDataPath))).toBe(false)
    if (process.platform !== 'win32') {
      expect(readdirSync(userDataPath).filter((entry) => entry.endsWith('.sock'))).toEqual([])
    }
  })

  it('still degrades to another port when the pin is only preferred', async () => {
    const port = await occupyLoopbackPort()
    const { server } = createServerOn(port, false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await server.start()

    const endpoint = server.getWebSocketEndpoint()
    expect(endpoint).not.toBeNull()
    expect(endpoint).not.toContain(`:${port}`)
    warn.mockRestore()
  })

  it('binds a free required pin exactly', async () => {
    const holder = await occupyLoopbackPort()
    await new Promise<void>((resolve) => holders.pop()?.close(() => resolve()))
    const { server } = createServerOn(holder, true)

    await server.start()

    expect(server.getWebSocketEndpoint()).toBe(`ws://127.0.0.1:${holder}`)
  })
})
