import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { resolveServeDataRoot } from '../serve-data-root'
import { formatServeDoctor, formatServePairing, formatServeStatus } from '../serve-admin-format'
import {
  ORCAD_SERVER_HEALTH_METHOD,
  ORCAD_SERVER_PAIRING_OFFER_METHOD,
  type OrcadPairingOfferReport,
  type OrcadServerHealth
} from '../../shared/orcad-server-health-contract'
import { RUNTIME_DEFAULT_WS_PORT } from '../../shared/runtime-default-ws-port'
import { resolveOrcadBindHost } from '../../main/orcad/orcad-bind-address'

const STATUS_TIMEOUT_MS = 15_000
const DOCTOR_PROBE_TIMEOUT_MS = 5_000

// Why named errors: an older orcad answers method_not_found, which is not "down", and a missing
// orcad is not fixed by `orca open` (the generic runtime_unavailable hint).
function explainServeFailure(dataRoot: string | null) {
  return (error: unknown): never => {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'server_health_unsupported',
        'This runtime does not publish server health: it is the desktop app or an orcad older than this CLI. Update orcad on the server host.'
      )
    }
    if (dataRoot && error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
      throw new RuntimeClientError(
        'server_not_running',
        `No orcad answered on data root ${dataRoot}. Start it (or check \`orca serve doctor\`), or pass --data-root.`
      )
    }
    throw error
  }
}

function readPort(flags: ReadonlyMap<string, string | boolean>): number | null {
  const raw = flags.get('port')
  if (raw === undefined) {
    return null
  }
  const port = Number(raw)
  if (typeof raw !== 'string' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RuntimeClientError('invalid_argument', `Invalid --port value: ${String(raw)}`)
  }
  return port
}

async function renderPairingQr(url: string): Promise<string | null> {
  try {
    const QRCode = await import('qrcode')
    return await QRCode.toString(url, { type: 'terminal', small: true })
  } catch {
    return null
  }
}

export const SERVE_ADMIN_HANDLERS: Record<string, CommandHandler> = {
  'serve status': async ({ flags, client, json }) => {
    const dataRoot = client.isRemote ? null : resolveServeDataRoot(flags)
    const target = dataRoot ? new RuntimeClient(dataRoot, STATUS_TIMEOUT_MS, null, null) : client
    const response = await target
      .call<OrcadServerHealth>(ORCAD_SERVER_HEALTH_METHOD, { fresh: flags.get('fresh') === true })
      .catch(explainServeFailure(dataRoot))
    printResult(response, json, formatServeStatus)
    if (response.result.state !== 'ready' || !response.result.live) {
      process.exitCode = 1
    }
  },
  'serve doctor': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(flags, 'serve doctor; it inspects this host. Run it on the server.')
    const dataRoot = resolveServeDataRoot(flags)
    const bindValue = flags.get('bind')
    const pinnedPort = readPort(flags)
    let running: OrcadServerHealth | null = null
    let runningError: string | null = null
    try {
      running = (
        await new RuntimeClient(
          dataRoot,
          DOCTOR_PROBE_TIMEOUT_MS,
          null,
          null
        ).call<OrcadServerHealth>(ORCAD_SERVER_HEALTH_METHOD, {})
      ).result
    } catch (error) {
      runningError = error instanceof RuntimeClientError ? error.code : String(error)
    }
    let bindHost: string
    try {
      bindHost = resolveOrcadBindHost(typeof bindValue === 'string' ? bindValue : undefined)
    } catch (error) {
      throw new RuntimeClientError(
        'invalid_argument',
        error instanceof Error ? error.message : String(error)
      )
    }
    // Why lazy: the doctor's host probes pull process-inspection modules only this command needs.
    const { runOrcadDoctor } = await import('../../main/orcad/orcad-doctor.js')
    const checks = await runOrcadDoctor({
      dataRoot,
      bindHost,
      port: pinnedPort ?? RUNTIME_DEFAULT_WS_PORT,
      portPinned: pinnedPort !== null,
      running,
      runningError
    })
    const report = { dataRoot, checks }
    if (json) {
      console.log(JSON.stringify({ result: report }, null, 2))
    } else {
      console.log(formatServeDoctor(report))
    }
    if (checks.some((check) => check.status === 'fail')) {
      process.exitCode = 1
    }
  },
  'serve pairing': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(
      flags,
      'serve pairing; pairing offers are minted only on the server host. Run it there.'
    )
    const dataRoot = resolveServeDataRoot(flags)
    const response = await new RuntimeClient(dataRoot, STATUS_TIMEOUT_MS, null, null)
      .call<OrcadPairingOfferReport>(ORCAD_SERVER_PAIRING_OFFER_METHOD, {
        rotate: flags.get('rotate') === true
      })
      .catch(explainServeFailure(dataRoot))
    const pairing = response.result
    if (json) {
      printResult(response, true, () => '')
    } else {
      const qr = pairing.available ? await renderPairingQr(pairing.url) : null
      console.log(formatServePairing(pairing, qr))
    }
    if (!pairing.available) {
      process.exitCode = 1
    }
  }
}
