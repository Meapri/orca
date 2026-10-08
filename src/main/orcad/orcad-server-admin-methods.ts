/**
 * orcad-only RPC methods behind `orca serve status` and `orca serve pairing`.
 *
 * Why registered only by orcad: the desktop host has no watchdog or health monitor to report,
 * so an older orcad or a desktop answers `method_not_found` and the CLI says the host predates
 * the surface — the capability check is the method's presence.
 */
import { z } from 'zod'
import { defineMethod } from '../runtime/rpc/core'
import type { ServePairingReadiness } from '../server/serve-readiness'
import type { OrcadServerHealth } from './orcad-health-monitor'
import {
  ORCAD_SERVER_HEALTH_METHOD,
  ORCAD_SERVER_PAIRING_OFFER_METHOD
} from '../../shared/orcad-server-health-contract'

export const SERVER_HEALTH_METHOD = ORCAD_SERVER_HEALTH_METHOD
export const SERVER_PAIRING_OFFER_METHOD = ORCAD_SERVER_PAIRING_OFFER_METHOD

const ServerHealthParams = z.object({
  fresh: z.boolean().optional(),
  // Why: the self-probe needs a round trip through auth and dispatch, not a health collection.
  probe: z.boolean().optional()
})

// Why optional scope: an older CLI sends none and means the runtime offer. An older orcad strips
// it and answers with a runtime offer, which the CLI detects from the reply's own `scope`.
const ServerPairingOfferParams = z.object({
  rotate: z.boolean().optional(),
  scope: z.enum(['runtime', 'mobile']).optional()
})

export type OrcadPairingOfferRequest = { rotate: boolean; scope: 'runtime' | 'mobile' }

export type OrcadServerAdminDeps = {
  serverHealth(options: { fresh: boolean }): Promise<OrcadServerHealth>
  pairingOffer(options: OrcadPairingOfferRequest): Promise<ServePairingReadiness>
}

export function createOrcadServerAdminMethods(deps: OrcadServerAdminDeps) {
  return [
    defineMethod({
      name: SERVER_HEALTH_METHOD,
      params: ServerHealthParams,
      handler: async (params): Promise<OrcadServerHealth | { probe: 'ok' }> =>
        params.probe ? { probe: 'ok' } : await deps.serverHealth({ fresh: params.fresh === true })
    }),
    defineMethod({
      name: SERVER_PAIRING_OFFER_METHOD,
      params: ServerPairingOfferParams,
      handler: async (params, ctx): Promise<ServePairingReadiness> => {
        // Why local only: minting a pairing credential stays with the host's own OS account.
        if (ctx.pairedDeviceId) {
          throw new Error(
            'server_pairing_local_only: run `orca serve pairing` on the server host itself'
          )
        }
        return deps.pairingOffer({
          rotate: params.rotate === true,
          scope: params.scope ?? 'runtime'
        })
      }
    })
  ]
}
