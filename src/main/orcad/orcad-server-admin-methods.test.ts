import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createWebSocketHttpServer } from '../runtime/rpc/ws-transport-http-server'
import { createOrcadServerAdminMethods } from './orcad-server-admin-methods'
import {
  createOrcadHealthProbeHandler,
  type OrcadHealthProbeSource
} from './orcad-health-probe-http'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

function methods() {
  const pairingOffer = vi.fn(() => ({
    available: false as const,
    reason: 'disabled_by_operator' as const,
    guidance: 'g'
  }))
  const serverHealth = vi.fn()
  const [health, pairing] = createOrcadServerAdminMethods({ serverHealth, pairingOffer })
  return { health, pairing, pairingOffer, serverHealth }
}

describe('server admin methods', () => {
  const runtime = new OrcaRuntimeService()

  it('answers the self-probe without collecting health', async () => {
    const { health, serverHealth } = methods()
    await expect(health.handler({ probe: true }, { runtime })).resolves.toEqual({ probe: 'ok' })
    expect(serverHealth).not.toHaveBeenCalled()
  })

  it('mints pairing offers for local callers only', async () => {
    const { pairing, pairingOffer } = methods()

    await expect(pairing.handler({}, { runtime, pairedDeviceId: 'device-1' })).rejects.toThrow(
      'server_pairing_local_only'
    )
    expect(pairingOffer).not.toHaveBeenCalled()

    await expect(pairing.handler({ rotate: true }, { runtime })).resolves.toMatchObject({
      available: false
    })
    expect(pairingOffer).toHaveBeenCalledWith({ rotate: true })
  })
})

const servers: ReturnType<typeof createWebSocketHttpServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

async function serveProbes(source: OrcadHealthProbeSource): Promise<string> {
  const server = createWebSocketHttpServer({
    tlsCert: undefined,
    tlsKey: undefined,
    staticRoot: undefined,
    probeRequestHandler: createOrcadHealthProbeHandler(source)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('probe server did not bind')
  }
  return `http://127.0.0.1:${address.port}`
}

describe('health probe handler', () => {
  const readiness = () => ({ state: 'ready' as const, degradations: [] })

  it('fails liveness only when the watchdog reports a wedge', async () => {
    const liveUrl = await serveProbes({ liveness: () => ({ live: true }), readiness })
    const wedgedUrl = await serveProbes({ liveness: () => ({ live: false }), readiness })

    expect((await fetch(`${liveUrl}/healthz`)).status).toBe(200)
    const wedged = await fetch(`${wedgedUrl}/healthz`)
    expect(wedged.status).toBe(503)
    expect(await wedged.json()).toEqual({ status: 'wedged' })
  })

  it('fails readiness on a critical degradation without exposing its message', async () => {
    const url = await serveProbes({
      liveness: () => ({ live: true }),
      readiness: () => ({
        state: 'not_ready',
        degradations: [
          {
            code: 'runtime_unresponsive',
            severity: 'critical',
            component: 'runtime',
            message: 'private detail'
          }
        ]
      })
    })

    const response = await fetch(`${url}/readyz?verbose=1`)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      status: 'not_ready',
      degradations: [{ code: 'runtime_unresponsive', severity: 'critical' }]
    })
  })

  it('answers HEAD without a body and 404s paths that are not probes', async () => {
    const url = await serveProbes({ liveness: () => ({ live: true }), readiness })

    const head = await fetch(`${url}/readyz`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await fetch(`${url}/metrics`)).status).toBe(404)
  })
})
