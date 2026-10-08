/**
 * Wire contract for orcad's Orca Relay administration: `orca serve relay status | sign-in |
 * sign-out` over the host-only local socket. In shared so the CLI reads it without the runtime's
 * module graph. Every field added later must be optional for older readers.
 *
 * Capability is the methods' presence: an older orcad or the desktop answers `method_not_found`.
 */
import type { MobileRelayStatus } from './mobile-relay-status'
import type { OrcaCloudSessionPersistence, OrcaProfileAuthState } from './orca-profiles'

export const ORCAD_RELAY_STATUS_METHOD = 'server.relay.status'
export const ORCAD_RELAY_SIGN_IN_METHOD = 'server.relay.signIn'
export const ORCAD_RELAY_SIGN_OUT_METHOD = 'server.relay.signOut'

export type OrcadRelaySignInOutcome = 'pending' | 'connected' | 'cancelled' | 'failed'

export type OrcadRelayReport = {
  /** orcad was started with `--relay`; without it the rest describes what would be used. */
  enabled: boolean
  /** Orca Cloud endpoints are configured for this build (packaged builds always are). */
  configured: boolean
  account: {
    state: OrcaProfileAuthState
    persistence: OrcaCloudSessionPersistence
    email?: string
    /** The account's `relay.use` entitlement, when a session has been read. */
    relayEntitled?: boolean
  }
  relay: {
    status: MobileRelayStatus
    /** Only while the host is actually served from a cell. */
    cellUrl?: string
  }
  /** The most recent `sign-in` this process ran, if any. */
  lastSignIn?: {
    outcome: OrcadRelaySignInOutcome
    error?: string
  }
}

export type OrcadRelaySignInStart =
  | {
      started: true
      /** Open in any browser; the redirect lands on the host's loopback `callbackPort`. */
      authorizeUrl: string
      callbackPort: number
    }
  | { started: false; reason: string; guidance: string }
