import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { resolveServeDataRoot } from '../serve-data-root'
import { formatServeDoctor, formatServeStatus } from '../serve-admin-format'
import { createServeHostClient, explainServeHostFailure } from '../serve-host-client'
import { SERVE_PAIRING_HANDLERS, SERVER_SURFACE_UNSUPPORTED } from './serve-pairing'
import { SERVE_RELAY_HANDLERS } from './serve-relay'
import {
  ORCAD_SERVER_HEALTH_METHOD,
  type OrcadServerHealth
} from '../../shared/orcad-server-health-contract'
import { RUNTIME_DEFAULT_WS_PORT } from '../../shared/runtime-default-ws-port'
import { resolveOrcadBindHost } from '../../main/orcad/orcad-bind-address'

const DOCTOR_PROBE_TIMEOUT_MS = 5_000

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

/** Every `orca serve …` administration command: one handler group, one local data-root resolver. */
export const SERVE_ADMIN_HANDLERS: Record<string, CommandHandler> = {
  'serve status': async ({ flags, client, json }) => {
    const dataRoot = client.isRemote ? null : resolveServeDataRoot(flags)
    const target = dataRoot ? createServeHostClient(dataRoot) : client
    const response = await target
      .call<OrcadServerHealth>(ORCAD_SERVER_HEALTH_METHOD, { fresh: flags.get('fresh') === true })
      .catch(explainServeHostFailure(dataRoot, SERVER_SURFACE_UNSUPPORTED))
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
        await createServeHostClient(dataRoot, DOCTOR_PROBE_TIMEOUT_MS).call<OrcadServerHealth>(
          ORCAD_SERVER_HEALTH_METHOD,
          {}
        )
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
  ...SERVE_PAIRING_HANDLERS,
  ...SERVE_RELAY_HANDLERS
}
