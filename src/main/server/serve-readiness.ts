import type { PairingOfferUnavailableReason } from '../runtime/runtime-rpc'
import type { OrcadHealth } from '../orcad/orcad-health'
import { formatWebClientUrlLines } from '../../shared/web-client-url-lines'

export type ServePairingUnavailableReason = PairingOfferUnavailableReason | 'disabled_by_operator'

export type ServePairingReadiness =
  | {
      available: true
      url: string
      endpoint: string
      deviceId: string
      webClientUrl: string | null
      /** One browser link per alternate endpoint, each dialing that endpoint. Additive. */
      webClientAlternateUrls?: string[]
      scope: 'runtime' | 'mobile'
      qr: string | null
      /** Epoch ms after which the unclaimed offer stops authenticating. Additive; absent = no expiry. */
      expiresAt?: number | null
    }
  | {
      available: false
      reason: ServePairingUnavailableReason
      guidance: string
    }

export type ServeReadiness = {
  runtimeId: string
  boundEndpoint: string | null
  advertisedEndpoint: string | null
  managedWslCliReconciliation: 'pending' | 'settled' | 'failed'
  pairing: ServePairingReadiness
  /** orcad `--mobile-pairing`: a phone offer beside the runtime one. Additive; absent = not asked. */
  mobilePairing?: ServePairingReadiness
  /**
   * Build identity, Node ABI and the cross-process terminal-daemon self-test.
   *
   * Optional because the Electron `--serve` host does not publish one yet; readers must
   * treat its absence as "not reported", never as healthy. Additive, so an older client
   * parsing this payload is unaffected.
   */
  health?: OrcadHealth
}

export type ServeReadinessOutput =
  | { mode: 'human' | 'json' }
  | { mode: 'recipe-json'; projectRoot: string }

type ReadinessWrite = (output: string) => Promise<void>

export class ServeReadinessPublisher {
  private state: 'pending' | 'publishing' | 'published' | 'failed' = 'pending'

  constructor(private readonly write: ReadinessWrite = writeStdout) {}

  async publish(readiness: ServeReadiness, output: ServeReadinessOutput): Promise<void> {
    if (this.state !== 'pending') {
      throw new Error(`Serve readiness publication already ${this.state}`)
    }
    this.state = 'publishing'
    try {
      await this.write(`${renderServeReadiness(readiness, output)}\n`)
      this.state = 'published'
    } catch (error) {
      this.state = 'failed'
      throw error
    }
  }
}

export function renderServeReadiness(
  readiness: ServeReadiness,
  output: ServeReadinessOutput
): string {
  if (output.mode === 'recipe-json') {
    if (!readiness.pairing.available) {
      throw new Error(
        `Recipe JSON output requires runtime pairing: ${readiness.pairing.reason}. ${readiness.pairing.guidance}`
      )
    }
    return JSON.stringify({
      schemaVersion: 1,
      pairingCode: readiness.pairing.url,
      projectRoot: output.projectRoot
    })
  }
  if (output.mode === 'json') {
    return JSON.stringify({
      type: 'orca_server_ready',
      schemaVersion: 1,
      runtimeId: readiness.runtimeId,
      endpoint: readiness.boundEndpoint,
      boundEndpoint: readiness.boundEndpoint,
      advertisedEndpoint: readiness.advertisedEndpoint,
      managedWslCliReconciliation: readiness.managedWslCliReconciliation,
      pairing: readiness.pairing,
      ...(readiness.mobilePairing ? { mobilePairing: readiness.mobilePairing } : {}),
      ...(readiness.health ? { health: readiness.health } : {})
    })
  }
  return renderHumanReadiness(readiness)
}

function renderHumanReadiness(readiness: ServeReadiness): string {
  const lines = [
    'Orca server ready',
    `Bound endpoint: ${readiness.boundEndpoint ?? 'websocket unavailable'}`,
    `Advertised endpoint: ${readiness.advertisedEndpoint ?? 'unavailable'}`
  ]
  if (readiness.health) {
    const daemon = readiness.health.terminalDaemon
    lines.push(
      `Build: ${readiness.health.buildVersion} (${readiness.health.buildHash}), Node ` +
        `${readiness.health.nodeVersion} ABI ${readiness.health.nodeAbi}`
    )
    lines.push(
      `Terminal daemon: ${daemon.state} — PTY self-test ${daemon.selfTest.ok ? 'passed' : 'FAILED'}` +
        ` (${daemon.selfTest.coverage}: ${daemon.selfTest.verdict})` +
        `; terminals survive an orcad restart: ${daemon.ownsFreshSessions ? 'yes' : 'NO'}`
    )
    for (const degradation of readiness.health.degradations ?? []) {
      lines.push(`Degraded (${degradation.severity}): ${degradation.message}`)
    }
  }
  lines.push(...renderHumanPairing(readiness.pairing, ''))
  if (readiness.mobilePairing) {
    lines.push(...renderHumanPairing(readiness.mobilePairing, 'Mobile '))
  }
  return lines.join('\n')
}

function renderHumanPairing(pairing: ServePairingReadiness, label: '' | 'Mobile '): string[] {
  if (!pairing.available) {
    return [
      `${label}Pairing unavailable: ${pairing.reason}`,
      `${label}Pairing guidance: ${pairing.guidance}`
    ]
  }
  const lines = formatWebClientUrlLines(pairing)
  if (pairing.scope === 'mobile' && pairing.qr) {
    lines.push(`Mobile pairing QR:\n${pairing.qr}`)
  }
  lines.push(`${label}Pairing URL: ${pairing.url}`)
  if (typeof pairing.expiresAt === 'number') {
    lines.push(
      `${label}Pairing URL expires: ${new Date(pairing.expiresAt).toISOString()} (mint another with \`orca serve pairing new${label ? ' --mobile' : ''}\`)`
    )
  }
  return lines
}

function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}
