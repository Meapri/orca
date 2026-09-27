// Live phone half of the orcad relay smoke: the REAL mobile pairing coordinator, relay client and
// E2EE v2 session dial a real relay and a real orcad. Opt-in; the orchestrator
// (config/scripts/orcad-relay-live-smoke.mjs) starts a local relay, a fake Orca Cloud and orcad,
// mints the offer, and runs this with:
//   ORCA_RELAY_LIVE_PAIRING_URL=orca://pair?code=... pnpm vitest run src/transport/relay-pairing-live.test.ts
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { parsePairingCode } from './pairing'
import { startPreProfilePairing } from './pre-profile-pairing-coordinator'
import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { HostProfile } from './types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(randomBytes(length))
}))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED' }))

const pairingUrl = process.env.ORCA_RELAY_LIVE_PAIRING_URL

describe.skipIf(!pairingUrl)('relay-only pairing against a live orcad', () => {
  it('pairs through the relay, installs a resume credential, and reconnects over it', async () => {
    const offer = parsePairingCode(pairingUrl ?? '')
    expect(offer?.relay).toBeDefined()
    const captured: { host?: HostProfile; credential?: MobileRelayCredentialBundle } = {}
    const winners: string[] = []
    const attempt = startPreProfilePairing({
      offer: offer!,
      timeoutMs: 60_000,
      connectOptions: {
        onLog: (entry) => {
          if (entry.message === 'Pairing path selected') {
            winners.push(entry.detail ?? '')
          }
        }
      },
      dependencies: {
        resolveHostIdentity: async (_publicKeyB64, hostId) => ({ id: hostId, name: 'orcad' }),
        savePairedHost: async (host) => {
          captured.host = host
        },
        saveJournal: async () => {},
        updateJournal: async () => {},
        clearJournal: async () => {},
        writeCredentialBundle: async (next) => {
          captured.credential = next
        },
        recordDescriptorFromStatus: () => {},
        platform: 'ios'
      }
    })
    await attempt.result
    // Why: the offer's direct endpoint is unroutable, so only the relay can have carried pairing.
    expect(winners).toEqual(['winner: relay'])
    const { host, credential } = captured
    if (!host?.relay || !credential) {
      throw new Error('pairing finished without a relay host and credential')
    }
    expect(host.relay.relayHostId).toBe(offer!.relay!.relayHostId)

    const session = connectMobileRelayRpcSession({
      relay: host.relay,
      resumeToken: credential.current.token,
      resumeCredentialVersion: credential.current.version,
      resumeConfirmReqId: randomUUID(),
      deviceToken: host.deviceToken,
      desktopPublicKeyB64: host.publicKeyB64
    })
    try {
      const reply = await session.sendRequest('status.get', undefined, { timeoutMs: 30_000 })
      expect(reply.ok).toBe(true)
    } finally {
      session.close()
    }
  }, 120_000)
})
