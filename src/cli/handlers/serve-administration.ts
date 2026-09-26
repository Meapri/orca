import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClient, RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { resolveHostAdministrationUserDataPath } from '../runtime/host-administration-target'
import {
  formatDevicesList,
  formatDevicesRevoke,
  formatPairingOffer
} from '../serve-administration-format'
import { parsePairingOfferLifetime } from '../../shared/pairing-offer-lifetime'
import { renderTerminalPairingQr } from '../../shared/terminal-pairing-qr'
import type {
  AdministeredPairingOffer,
  DevicesListResult,
  DevicesRevokeResult,
  DevicesRotateResult,
  PairingCreateResult
} from '../../shared/runtime-device-administration'

const REMOTE_SELECTION_SUFFIX =
  'device administration: it acts on the Orca runtime on this machine. Run it on the host you want to administer (for example over SSH).'

// Why: explicit-null selectors so an ambient ORCA_PAIRING_CODE / ORCA_ENVIRONMENT can never
// redirect a credential mutation to some other paired server.
function createHostClient(): RuntimeClient {
  return new RuntimeClient(resolveHostAdministrationUserDataPath(), undefined, null, null)
}

async function callHost<TResult>(
  method: string,
  params?: unknown
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    return await createHostClient().call<TResult>(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'The running Orca runtime does not support device administration. Update Orca on this host and restart it.'
      )
    }
    throw error
  }
}

function requireDeviceId(flags: HandlerContext['flags']): string {
  const deviceId = flags.get('device')
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Pass the device id to act on.')
  }
  return deviceId.trim()
}

function optionalStringFlag(flags: HandlerContext['flags'], name: string): string | undefined {
  const value = flags.get(name)
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
  }
  return value
}

function resolvePairingScope(flags: HandlerContext['flags']): 'runtime' | 'mobile' {
  if (flags.get('mobile') === true && flags.get('runtime') === true) {
    throw new RuntimeClientError('invalid_argument', 'Use either --mobile or --runtime, not both.')
  }
  return flags.get('mobile') === true ? 'mobile' : 'runtime'
}

function resolveLifetimeMs(flags: HandlerContext['flags']): number | undefined {
  const raw = optionalStringFlag(flags, 'expires')
  if (raw === undefined) {
    return undefined
  }
  const parsed = parsePairingOfferLifetime(raw)
  if (!parsed.ok) {
    throw new RuntimeClientError('invalid_argument', parsed.message)
  }
  return parsed.ms
}

// Why: an unavailable offer is a refusal the operator must act on, so it exits non-zero.
function requireAvailableOffer<T extends { available: true }>(
  result: T | { available: false; reason: string; guidance: string }
): T {
  if (!result.available) {
    throw new RuntimeClientError(result.reason, result.guidance)
  }
  return result
}

async function printOffer(
  response: RuntimeRpcSuccess<AdministeredPairingOffer>,
  json: boolean
): Promise<void> {
  const qr =
    !json && response.result.scope === 'mobile'
      ? await renderTerminalPairingQr(response.result.pairingUrl)
      : null
  printResult(response, json, (offer) => formatPairingOffer(offer, qr))
}

export const SERVE_ADMINISTRATION_HANDLERS: Record<string, CommandHandler> = {
  'serve devices list': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    printResult(await callHost<DevicesListResult>('devices.list'), json, formatDevicesList)
  },
  'serve devices revoke': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    const response = await callHost<DevicesRevokeResult>('devices.revoke', {
      deviceId: requireDeviceId(flags)
    })
    if (!response.result.revoked) {
      process.exitCode = 1
    }
    printResult(response, json, formatDevicesRevoke)
  },
  'serve devices rotate': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    const response = await callHost<DevicesRotateResult>('devices.rotate', {
      deviceId: requireDeviceId(flags),
      address: optionalStringFlag(flags, 'pairing-address')
    })
    await printOffer({ ...response, result: requireAvailableOffer(response.result) }, json)
  },
  'serve pairing new': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    const response = await callHost<PairingCreateResult>('pairing.create', {
      scope: resolvePairingScope(flags),
      address: optionalStringFlag(flags, 'pairing-address'),
      name: optionalStringFlag(flags, 'name'),
      expiresInMs: resolveLifetimeMs(flags)
    })
    await printOffer({ ...response, result: requireAvailableOffer(response.result) }, json)
  }
}
