import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { callServeHost } from '../serve-host-client'
import { formatServePairing } from '../serve-admin-format'
import {
  formatDevicesList,
  formatDevicesRevoke,
  formatPairingOffer
} from '../serve-administration-format'
import { parsePairingOfferLifetime } from '../../shared/pairing-offer-lifetime'
import { renderTerminalPairingQr } from '../../shared/terminal-pairing-qr'
import {
  ORCAD_SERVER_PAIRING_OFFER_METHOD,
  type OrcadPairingOfferReport
} from '../../shared/orcad-server-health-contract'
import type {
  AdministeredPairingOffer,
  DevicesListResult,
  DevicesRevokeResult,
  DevicesRotateResult,
  PairingCreateResult
} from '../../shared/runtime-device-administration'

const REMOTE_SELECTION_SUFFIX =
  'device administration: it acts on the Orca runtime on this machine. Run it on the host you want to administer (for example over SSH).'

export const SERVER_SURFACE_UNSUPPORTED = new RuntimeClientError(
  'server_health_unsupported',
  'This runtime does not publish server health: it is the desktop app or an orcad older than this CLI. Update orcad on the server host.'
)

const MOBILE_PAIRING_SHOW_UNSUPPORTED = new RuntimeClientError(
  'server_mobile_pairing_unsupported',
  'This orcad predates `orca serve pairing --mobile`. Update orcad, or mint a phone offer with `orca serve pairing new --mobile --pairing-address <address>`.'
)

const DEVICE_ADMINISTRATION_UNSUPPORTED = new RuntimeClientError(
  'incompatible_runtime',
  'The running Orca runtime does not support device administration. Update Orca on this host and restart it.'
)

function callHost<TResult>(
  flags: HandlerContext['flags'],
  method: string,
  params?: unknown
): Promise<RuntimeRpcSuccess<TResult>> {
  return callServeHost<TResult>(flags, method, params, DEVICE_ADMINISTRATION_UNSUPPORTED)
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

/** `serve pairing` (alias `serve pairing show`), `serve pairing new` and `serve devices …`. */
export const SERVE_PAIRING_HANDLERS: Record<string, CommandHandler> = {
  'serve pairing': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(
      flags,
      'serve pairing; pairing offers are minted only on the server host. Run it there.'
    )
    const scope = flags.get('mobile') === true ? 'mobile' : 'runtime'
    const response = await callServeHost<OrcadPairingOfferReport>(
      flags,
      ORCAD_SERVER_PAIRING_OFFER_METHOD,
      { rotate: flags.get('rotate') === true, ...(scope === 'mobile' ? { scope } : {}) },
      SERVER_SURFACE_UNSUPPORTED
    )
    const pairing = response.result
    // Why: an orcad older than `--mobile` ignores the scope and answers with its runtime offer.
    if (pairing.available && pairing.scope !== scope) {
      throw MOBILE_PAIRING_SHOW_UNSUPPORTED
    }
    if (json) {
      printResult(response, true, () => '')
    } else {
      const qr = pairing.available ? await renderTerminalPairingQr(pairing.url) : null
      console.log(formatServePairing(pairing, qr))
    }
    if (!pairing.available) {
      process.exitCode = 1
    }
  },
  'serve pairing new': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    const scope = resolvePairingScope(flags)
    if (flags.get('relay') === true && scope !== 'mobile') {
      throw new RuntimeClientError('invalid_argument', '--relay pairs phones only; add --mobile.')
    }
    const response = await callHost<PairingCreateResult>(flags, 'pairing.create', {
      scope,
      address: optionalStringFlag(flags, 'pairing-address'),
      name: optionalStringFlag(flags, 'name'),
      expiresInMs: resolveLifetimeMs(flags),
      // Why only when asked: an older host refuses the unknown key, which is right only for --relay.
      ...(flags.get('relay') === true ? { relay: true } : {})
    })
    await printOffer({ ...response, result: requireAvailableOffer(response.result) }, json)
  },
  'serve devices list': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    printResult(await callHost<DevicesListResult>(flags, 'devices.list'), json, formatDevicesList)
  },
  'serve devices revoke': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    const response = await callHost<DevicesRevokeResult>(flags, 'devices.revoke', {
      deviceId: requireDeviceId(flags)
    })
    if (!response.result.revoked) {
      process.exitCode = 1
    }
    printResult(response, json, formatDevicesRevoke)
  },
  'serve devices rotate': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, REMOTE_SELECTION_SUFFIX)
    const response = await callHost<DevicesRotateResult>(flags, 'devices.rotate', {
      deviceId: requireDeviceId(flags),
      address: optionalStringFlag(flags, 'pairing-address')
    })
    await printOffer({ ...response, result: requireAvailableOffer(response.result) }, json)
  }
}
