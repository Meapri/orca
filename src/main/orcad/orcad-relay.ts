/**
 * Orca Relay on orcad (`--relay`): the desktop's relay service, served from a headless host so a
 * phone can reach a VPS that has no open port. The host keeps one outbound control socket to a
 * relay cell while a relay-paired phone exists (the demand ledger decides), and every phone byte
 * is E2EE v2 ciphertext keyed to this host's pinned key, so the relay only splices ciphertext.
 *
 * Sign-in is the desktop's PKCE flow; the authorize URL goes to the waiting CLI instead of a
 * browser, and its redirect lands on this host's loopback (reach it with an SSH forward).
 */
import { z } from 'zod'
import { defineMethod } from '../runtime/rpc/core'
import { requireHostAdministration } from '../runtime/rpc/methods/device-administration'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { DesktopRelayService } from '../runtime/relay/desktop-relay-service'
import { relayPairingProvider } from '../runtime/relay/relay-pairing-provider'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { allowHostUnsealedOrcaCloudSessionPersistence } from '../orca-profiles/profile-cloud-session-store'
import {
  connectCurrentOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  signOutCurrentOrcaProfile
} from '../orca-profiles/profile-cloud-service'
import { RELAY_HOST_CLOSE_REASON } from '../../shared/relay-host-close-reason'
import { relayStatusCellUrl, type MobileRelayStatus } from '../../shared/mobile-relay-status'
import {
  ORCAD_RELAY_SIGN_IN_METHOD,
  ORCAD_RELAY_SIGN_OUT_METHOD,
  ORCAD_RELAY_STATUS_METHOD,
  type OrcadRelayReport,
  type OrcadRelaySignInOutcome,
  type OrcadRelaySignInStart
} from '../../shared/orcad-relay-contract'

const RELAY_NOT_ENABLED_GUIDANCE =
  'This orcad was started without --relay. Add --relay to its command line and restart it.'

type PendingSignIn = { start: Promise<OrcadRelaySignInStart> }

export type OrcadRelayControl = {
  methods: ReturnType<typeof createOrcadRelayMethods>
  /** After the RPC listener is up: the relay service needs the E2EE key and socket wiring. */
  attach(rpc: OrcaRuntimeRpcServer): void
  stop(): void
}

export function createOrcadRelayControl(options: {
  enabled: boolean
  userDataPath: string
  appVersion: string
  log?: (line: string) => void
}): OrcadRelayControl {
  const log = options.log ?? ((line: string) => console.error(line))
  let service: DesktopRelayService | null = null
  let rpc: OrcaRuntimeRpcServer | null = null
  let relayStatus: MobileRelayStatus = 'offline'
  let relayCellUrl: string | undefined
  let pendingSignIn: PendingSignIn | null = null
  let lastSignIn: OrcadRelayReport['lastSignIn']

  if (options.enabled) {
    // Why before any read: a session saved by an earlier run is only readable once opted in.
    allowHostUnsealedOrcaCloudSessionPersistence()
  }

  const report = (): OrcadRelayReport => {
    const configState = getOrcaCloudAuthConfig()
    const auth = getCurrentOrcaProfileAuthStatus(options.userDataPath)
    const entitled = auth.capabilities?.flags['relay.use']
    const cellUrl = relayStatusCellUrl(relayStatus, relayCellUrl)
    return {
      enabled: options.enabled,
      configured: configState.configured,
      account: {
        state: auth.state,
        persistence: auth.persistence,
        ...(auth.cloud?.email ? { email: auth.cloud.email } : {}),
        ...(entitled === undefined ? {} : { relayEntitled: entitled })
      },
      relay: { status: relayStatus, ...(cellUrl ? { cellUrl } : {}) },
      ...(lastSignIn ? { lastSignIn } : {})
    }
  }

  const finishSignIn = (outcome: OrcadRelaySignInOutcome, error?: string): void => {
    pendingSignIn = null
    lastSignIn = { outcome, ...(error ? { error } : {}) }
    log(`[orcad] relay sign-in ${outcome}${error ? `: ${error}` : ''}`)
    if (outcome === 'connected') {
      service?.authMutated()
    }
  }

  const signIn = (): Promise<OrcadRelaySignInStart> => {
    if (!options.enabled) {
      return Promise.resolve({
        started: false,
        reason: 'relay_not_enabled',
        guidance: RELAY_NOT_ENABLED_GUIDANCE
      })
    }
    // Why coalesce: a second CLI must see the same URL, not orphan the first loopback listener.
    if (pendingSignIn) {
      return pendingSignIn.start
    }
    let announce!: (start: OrcadRelaySignInStart) => void
    const start = new Promise<OrcadRelaySignInStart>((resolve) => {
      announce = resolve
    })
    pendingSignIn = { start }
    lastSignIn = { outcome: 'pending' }
    void connectCurrentOrcaProfile(options.userDataPath, {
      openAuthorizeUrl: async (authorizeUrl) => {
        const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri')
        const callbackPort = redirect ? Number(new URL(redirect).port) : 0
        announce({ started: true, authorizeUrl, callbackPort })
      }
    }).then(
      (result) => {
        const error = result.status === 'failed' ? result.error : undefined
        const outcome: OrcadRelaySignInOutcome =
          result.status === 'connected'
            ? 'connected'
            : result.status === 'cancelled'
              ? 'cancelled'
              : 'failed'
        announce({
          started: false,
          reason: `sign_in_${outcome}`,
          guidance:
            result.status === 'unconfigured'
              ? 'Orca Cloud sign-in is not configured for this build.'
              : (error ?? 'Sign-in ended before a browser was needed.')
        })
        finishSignIn(outcome, error)
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        announce({ started: false, reason: 'sign_in_failed', guidance: message })
        finishSignIn('failed', message)
      }
    )
    return start
  }

  const signOut = async (): Promise<OrcadRelayReport> => {
    // Why fence first: a paired phone is told "signed out" before the account is unlinked.
    service?.fenceAndCloseNow(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    await signOutCurrentOrcaProfile(options.userDataPath)
    service?.authMutated()
    return report()
  }

  return {
    methods: createOrcadRelayMethods({ report, signIn, signOut }),
    attach(nextRpc) {
      rpc = nextRpc
      if (!options.enabled) {
        return
      }
      const configState = getOrcaCloudAuthConfig()
      if (!configState.configured) {
        log(`[orcad] relay unavailable: ${configState.setupMessage}`)
        return
      }
      try {
        service = new DesktopRelayService({
          authConfig: configState.config,
          userDataPath: options.userDataPath,
          appVersion: options.appVersion,
          runtimeRpc: nextRpc,
          onStatus: (status, cellUrl) => {
            if (status !== relayStatus) {
              log(`[orcad] relay ${status}`)
            }
            relayStatus = status
            relayCellUrl = cellUrl
          }
        })
        nextRpc.setMobileRelayPairingProvider(relayPairingProvider(service))
        service.start()
        log(`[orcad] relay enabled via ${configState.config.relayDirectorUrl}`)
      } catch (error) {
        service = null
        log(`[orcad] relay unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    stop() {
      if (!service) {
        return
      }
      rpc?.setMobileRelayPairingProvider(null)
      service.stop()
      service = null
    }
  }
}

function createOrcadRelayMethods(handlers: {
  report(): OrcadRelayReport
  signIn(): Promise<OrcadRelaySignInStart>
  signOut(): Promise<OrcadRelayReport>
}) {
  // Why host-only: signing in links this host to an Orca account, which no paired device may do.
  return [
    defineMethod({
      name: ORCAD_RELAY_STATUS_METHOD,
      permission: 'pairing-admin',
      params: null,
      handler: (_params, ctx): OrcadRelayReport => {
        requireHostAdministration(ctx)
        return handlers.report()
      }
    }),
    defineMethod({
      name: ORCAD_RELAY_SIGN_IN_METHOD,
      permission: 'pairing-admin',
      params: z.object({}).strict().optional(),
      handler: async (_params, ctx): Promise<OrcadRelaySignInStart> => {
        requireHostAdministration(ctx)
        return await handlers.signIn()
      }
    }),
    defineMethod({
      name: ORCAD_RELAY_SIGN_OUT_METHOD,
      permission: 'pairing-admin',
      params: null,
      handler: async (_params, ctx): Promise<OrcadRelayReport> => {
        requireHostAdministration(ctx)
        return await handlers.signOut()
      }
    })
  ]
}
