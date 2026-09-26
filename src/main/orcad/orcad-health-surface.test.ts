import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { readRuntimeMetadata } from '../runtime/runtime-metadata'
import { createOrcadHealthSurface, type OrcadHealthSurface } from './orcad-health-surface'
import { sendLocalRuntimeRpcRequest } from './orcad-local-rpc-request'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function startServer(options: { noPairing: boolean }): Promise<{
  surface: OrcadHealthSurface
  rpc: OrcaRuntimeRpcServer
  userDataPath: string
  baseUrl: string
}> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-health-surface-'))
  const surface = createOrcadHealthSurface({
    userDataPath,
    buildVersion: '9.9.9-test',
    profileStateAuthority: undefined,
    systemdNotify: null
  })
  const rpc = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0,
    pinnedBindHost: '127.0.0.1',
    extraMethods: surface.extraMethods,
    httpProbeHandler: surface.httpProbeHandler
  })
  await rpc.start()
  cleanups.push(async () => {
    await surface.stop()
    await rpc.stop()
  })
  surface.attach({
    rpc,
    runtimeDegradations: () => [],
    listLocalTerminals: async () => [{ id: 'pty-1' }, { id: 'pty-2' }],
    pairing: { noPairing: options.noPairing, pairingAddress: undefined }
  })
  const endpoint = rpc.getWebSocketEndpoint()
  if (!endpoint) {
    throw new Error('listener did not bind')
  }
  return { surface, rpc, userDataPath, baseUrl: endpoint.replace('ws://', 'http://') }
}

async function callLocal(userDataPath: string, method: string, params: unknown): Promise<unknown> {
  const metadata = readRuntimeMetadata(userDataPath)
  if (!metadata) {
    throw new Error('no metadata')
  }
  return await sendLocalRuntimeRpcRequest({
    metadata,
    method,
    params,
    timeoutMs: 5_000,
    maxResponseBytes: 1024 * 1024,
    toError: (failure) => new Error(JSON.stringify(failure))
  })
}

describe('orcad health surface', () => {
  it('answers not-ready until readiness publishes, then serves probes and server.health', async () => {
    const { surface, userDataPath, baseUrl } = await startServer({ noPairing: false })

    const early = await fetch(`${baseUrl}/readyz`)
    expect(early.status).toBe(503)
    expect(await early.json()).toEqual({ status: 'starting', degradations: [] })

    const initial = await surface.collectInitialHealth()
    expect(initial.degradations?.map((entry) => entry.code)).toContain('terminal_daemon_absent')
    await surface.published()

    const ready = await fetch(`${baseUrl}/readyz`)
    expect(ready.status).toBe(200)
    const readyBody = await ready.json()
    expect(readyBody.status).toBe('ready')
    expect(readyBody.degradations).toContainEqual({
      code: 'terminal_daemon_absent',
      severity: 'warning'
    })
    // Unauthenticated bodies carry codes only.
    expect(JSON.stringify(readyBody)).not.toContain('message')

    const live = await fetch(`${baseUrl}/healthz`)
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({ status: 'ok' })

    await vi.waitFor(async () => {
      const result = await callLocal(userDataPath, 'server.health', {})
      expect(result).toMatchObject({
        state: 'ready',
        live: true,
        health: { buildVersion: '9.9.9-test', watchdog: { runtimeProbe: { state: 'ok' } } },
        stats: { localTerminals: 2, connectedClients: 0 }
      })
    })
  })

  it('refuses non-probe methods and unknown paths on the listener', async () => {
    const { baseUrl } = await startServer({ noPairing: false })

    expect((await fetch(`${baseUrl}/healthz`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${baseUrl}/not-a-probe`)).status).toBe(404)
  })

  it('reprints the same pending pairing offer until a device uses it', async () => {
    const { userDataPath } = await startServer({ noPairing: false })

    const first = await callLocal(userDataPath, 'server.pairingOffer', {})
    const second = await callLocal(userDataPath, 'server.pairingOffer', {})
    const rotated = await callLocal(userDataPath, 'server.pairingOffer', { rotate: true })

    expect(first).toMatchObject({ available: true, scope: 'runtime' })
    expect(second).toEqual(first)
    expect(rotated).toMatchObject({ available: true })
    expect(rotated).not.toEqual(first)
  })

  it('reports pairing disabled when the operator started with --no-pairing', async () => {
    const { userDataPath } = await startServer({ noPairing: true })

    expect(await callLocal(userDataPath, 'server.pairingOffer', {})).toMatchObject({
      available: false,
      reason: 'disabled_by_operator'
    })
  })
})
