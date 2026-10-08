import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { DeviceAdministrationRpcContext } from '../runtime/rpc/device-administration-context'
import { createOrcadRelayControl } from './orcad-relay'
import { startFakeOrcaCloudApi, type FakeOrcaCloudApi } from './__fixtures__/fake-orca-cloud-api'
import {
  ORCAD_RELAY_SIGN_IN_METHOD,
  ORCAD_RELAY_SIGN_OUT_METHOD,
  ORCAD_RELAY_STATUS_METHOD
} from '../../shared/orcad-relay-contract'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only getRuntimeId.
const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
// Why an empty implementation: the host-only guard checks only that the owner socket supplied one.
const administration: DeviceAdministrationRpcContext = {
  listDevices: () => ({ devices: [], serverKeyFingerprint: null }),
  revokeDevice: async (deviceId) => ({ revoked: false, deviceId, closedConnections: 0 }),
  rotateDevice: () => ({ available: false, reason: 'unused', guidance: 'unused' }),
  createPairingOffer: async () => ({ available: false, reason: 'unused', guidance: 'unused' })
}

function callAsHost(control: ReturnType<typeof createOrcadRelayControl>, method: string) {
  return new RpcDispatcher({ runtime, methods: control.methods }).dispatch(
    { id: 'req-1', authToken: 'tok', method },
    { deviceAdministration: administration }
  )
}

function readAuthorizeUrl(value: unknown): { authorizeUrl: string; callbackPort: number } {
  if (
    typeof value === 'object' &&
    value !== null &&
    'authorizeUrl' in value &&
    typeof value.authorizeUrl === 'string' &&
    'callbackPort' in value &&
    typeof value.callbackPort === 'number'
  ) {
    return { authorizeUrl: value.authorizeUrl, callbackPort: value.callbackPort }
  }
  throw new Error(`sign-in did not start: ${JSON.stringify(value)}`)
}

describe('orcad relay control', () => {
  let userDataPath = ''
  let cloud: FakeOrcaCloudApi | null = null

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orcad-relay-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await cloud?.stop()
    cloud = null
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('reports relay disabled and refuses sign-in without --relay', async () => {
    const control = createOrcadRelayControl({ enabled: false, userDataPath, appVersion: 'test' })
    expect(await callAsHost(control, ORCAD_RELAY_STATUS_METHOD)).toMatchObject({
      ok: true,
      result: { enabled: false, relay: { status: 'offline' } }
    })
    expect(await callAsHost(control, ORCAD_RELAY_SIGN_IN_METHOD)).toMatchObject({
      ok: true,
      result: { started: false, reason: 'relay_not_enabled' }
    })
  })

  it.each(['mobile', 'runtime'] as const)(
    'refuses every relay method to a %s client',
    async (kind) => {
      const control = createOrcadRelayControl({ enabled: true, userDataPath, appVersion: 'test' })
      const dispatcher = new RpcDispatcher({ runtime, methods: control.methods })
      for (const method of [
        ORCAD_RELAY_STATUS_METHOD,
        ORCAD_RELAY_SIGN_IN_METHOD,
        ORCAD_RELAY_SIGN_OUT_METHOD
      ]) {
        expect(
          await dispatcher.dispatch(
            { id: 'req-1', authToken: 'tok', method },
            { clientKind: kind, deviceAdministration: administration }
          )
        ).toMatchObject({ ok: false })
      }
    }
  )

  it('signs the host in through the PKCE loopback and reports the account', async () => {
    cloud = await startFakeOrcaCloudApi()
    vi.stubEnv('ORCA_CLOUD_API_URL', cloud.url)
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'orcad-test')
    const lines: string[] = []
    const control = createOrcadRelayControl({
      enabled: true,
      userDataPath,
      appVersion: 'test',
      log: (line) => lines.push(line)
    })
    const first = await callAsHost(control, ORCAD_RELAY_SIGN_IN_METHOD)
    const start = readAuthorizeUrl(first.ok ? first.result : first)
    expect(start.callbackPort).toBeGreaterThan(0)
    // A second CLI while the first waits sees the same URL, not a second listener.
    expect(await callAsHost(control, ORCAD_RELAY_SIGN_IN_METHOD)).toMatchObject({
      ok: true,
      result: start
    })

    // The "browser": follow the authorize redirect back to the host's loopback callback.
    const callback = await fetch(start.authorizeUrl)
    expect(callback.status).toBe(200)

    await vi.waitFor(async () => {
      expect(await callAsHost(control, ORCAD_RELAY_STATUS_METHOD)).toMatchObject({
        ok: true,
        result: {
          lastSignIn: { outcome: 'connected' },
          account: { state: 'connected', email: 'relay-smoke@example.test', relayEntitled: true }
        }
      })
    })
    expect(lines).toContain('[orcad] relay sign-in connected')
  })
})
