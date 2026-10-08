import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import type { DeviceAdministrationRpcContext } from '../device-administration-context'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import { CLIENT_UI_METHODS } from './client-ui'
import {
  DEVICE_ADMINISTRATION_METHODS,
  HOST_ONLY_DEVICE_ADMINISTRATION_MESSAGE
} from './device-administration'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function createAdministration(): DeviceAdministrationRpcContext {
  return {
    listDevices: vi.fn(() => ({ devices: [], serverKeyFingerprint: null })),
    revokeDevice: vi.fn(async (deviceId: string) => ({
      revoked: true,
      deviceId,
      closedConnections: 0
    })),
    rotateDevice: vi.fn(() => ({ available: false as const, reason: 'x', guidance: 'y' })),
    createPairingOffer: vi.fn(async () => ({
      available: false as const,
      reason: 'x',
      guidance: 'y'
    }))
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only getRuntimeId.
const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService

describe('host-only device administration methods', () => {
  it('serves the owner-token socket', async () => {
    const administration = createAdministration()
    const dispatcher = new RpcDispatcher({ runtime, methods: DEVICE_ADMINISTRATION_METHODS })

    const response = await dispatcher.dispatch(makeRequest('devices.revoke', { deviceId: 'd1' }), {
      deviceAdministration: administration
    })

    expect(response).toMatchObject({ ok: true, result: { revoked: true, deviceId: 'd1' } })
    expect(administration.revokeDevice).toHaveBeenCalledWith('d1')
  })

  it.each(['mobile', 'runtime'] as const)(
    'refuses a %s-scoped paired caller',
    async (clientKind) => {
      const administration = createAdministration()
      const dispatcher = new RpcDispatcher({ runtime, methods: DEVICE_ADMINISTRATION_METHODS })

      for (const [method, params] of [
        ['devices.list', undefined],
        ['devices.revoke', { deviceId: 'd1' }],
        ['devices.rotate', { deviceId: 'd1' }],
        ['pairing.create', { scope: 'runtime' }]
      ] as const) {
        const response = await dispatcher.dispatch(makeRequest(method, params), {
          clientKind,
          deviceAdministration: administration
        })
        expect(response).toMatchObject({
          ok: false,
          error: expect.objectContaining({ message: HOST_ONLY_DEVICE_ADMINISTRATION_MESSAGE })
        })
      }
      expect(administration.revokeDevice).not.toHaveBeenCalled()
      expect(administration.createPairingOffer).not.toHaveBeenCalled()
    }
  )

  it('refuses a caller whose transport supplied no administration context', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: DEVICE_ADMINISTRATION_METHODS })

    const response = await dispatcher.dispatch(makeRequest('devices.list'))

    expect(response).toMatchObject({ ok: false })
  })

  it('never enters the mobile allowlist', () => {
    for (const method of DEVICE_ADMINISTRATION_METHODS) {
      expect(MOBILE_RPC_METHOD_ALLOWLIST.has(method.name)).toBe(false)
    }
  })
})

describe('settings.update from paired callers', () => {
  function createSettingsDispatcher() {
    const updateClientSettings = vi.fn(async (update: unknown) => update)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings.update reads only these two members.
    const settingsRuntime = {
      getRuntimeId: () => 'test-runtime',
      updateClientSettings
    } as unknown as OrcaRuntimeService
    return {
      updateClientSettings,
      dispatcher: new RpcDispatcher({ runtime: settingsRuntime, methods: CLIENT_UI_METHODS })
    }
  }

  it('refuses agent launch env from a mobile token', async () => {
    const { dispatcher, updateClientSettings } = createSettingsDispatcher()

    for (const params of [
      { agentDefaultEnv: { claude: { LD_PRELOAD: '/tmp/x.so' } } },
      { agentDefaultArgs: { claude: '--dangerously-skip-permissions' } }
    ]) {
      const response = await dispatcher.dispatch(makeRequest('settings.update', params), {
        clientKind: 'mobile'
      })
      expect(response).toMatchObject({ ok: false })
    }
    expect(updateClientSettings).not.toHaveBeenCalled()
  })

  it('still lets a mobile token write ordinary preferences', async () => {
    const { dispatcher, updateClientSettings } = createSettingsDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('settings.update', { compactWorktreeCards: true }),
      { clientKind: 'mobile' }
    )

    expect(response).toMatchObject({ ok: true })
    expect(updateClientSettings).toHaveBeenCalledWith({ compactWorktreeCards: true })
  })

  it.each([undefined, 'runtime'] as const)(
    'keeps agent launch env writable for %s callers',
    async (clientKind) => {
      const { dispatcher, updateClientSettings } = createSettingsDispatcher()

      const response = await dispatcher.dispatch(
        makeRequest('settings.update', { agentDefaultEnv: { claude: { FOO: 'bar' } } }),
        clientKind ? { clientKind } : undefined
      )

      expect(response).toMatchObject({ ok: true })
      expect(updateClientSettings).toHaveBeenCalledTimes(1)
    }
  )
})
