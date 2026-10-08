import { defineMethod, type RpcContext } from '../core'
import type { DeviceAdministrationRpcContext } from '../device-administration-context'
import {
  DevicesRevokeParams,
  DevicesRotateParams,
  PairingCreateParams
} from '../../../../shared/rpc-contract/device-administration-params'

export const HOST_ONLY_DEVICE_ADMINISTRATION_MESSAGE =
  'Device and pairing administration is only available to the local Orca CLI on the host.'

// Why both checks: a paired token (any scope) must never mint or revoke grants — a mobile or runtime
// client that could would escalate to host authority — and only the owner-token socket supplies the context.
export function requireHostAdministration(ctx: RpcContext): DeviceAdministrationRpcContext {
  if (ctx.clientKind !== undefined || !ctx.deviceAdministration) {
    throw new Error(HOST_ONLY_DEVICE_ADMINISTRATION_MESSAGE)
  }
  return ctx.deviceAdministration
}

export const DEVICE_ADMINISTRATION_METHODS = [
  defineMethod({
    name: 'devices.list',
    permission: 'pairing-admin',
    params: null,
    handler: (_params, ctx) => requireHostAdministration(ctx).listDevices()
  }),
  defineMethod({
    name: 'devices.revoke',
    permission: 'pairing-admin',
    params: DevicesRevokeParams,
    handler: async (params, ctx) => requireHostAdministration(ctx).revokeDevice(params.deviceId)
  }),
  defineMethod({
    name: 'devices.rotate',
    permission: 'pairing-admin',
    params: DevicesRotateParams,
    handler: (params, ctx) => requireHostAdministration(ctx).rotateDevice(params)
  }),
  defineMethod({
    name: 'pairing.create',
    permission: 'pairing-admin',
    params: PairingCreateParams,
    handler: async (params, ctx) => requireHostAdministration(ctx).createPairingOffer(params)
  })
]
