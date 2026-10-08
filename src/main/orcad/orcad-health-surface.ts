/**
 * Wires orcad's continuous health: monitor, self-watchdog, `/healthz` + `/readyz`, the
 * `server.*` RPC methods and systemd notify. orcad-entry calls it at four points (construct,
 * after the listener binds, after readiness publishes, at shutdown) and owns nothing else here.
 */
import { stat } from 'node:fs/promises'
import process from 'node:process'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type { RuntimeDegradation } from '../../shared/runtime-types'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { ServePairingReadiness } from '../server/serve-readiness'
import { readRuntimeMetadata } from '../runtime/runtime-metadata'
import { collectOrcadHealth, type OrcadHealth } from './orcad-health'
import { OrcadHealthMonitor } from './orcad-health-monitor'
import { createOrcadHealthProbeHandler } from './orcad-health-probe-http'
import { sendLocalRuntimeRpcRequest } from './orcad-local-rpc-request'
import { OrcadRuntimeWatchdog } from './orcad-runtime-watchdog'
import {
  createOrcadServerAdminMethods,
  SERVER_HEALTH_METHOD,
  type OrcadPairingOfferRequest
} from './orcad-server-admin-methods'
import {
  createSystemdNotifySend,
  OrcadSystemdNotifier,
  type SystemdNotifyEnvironment
} from './orcad-systemd-notify'
import type { OrcadProfileStateAuthoritySelection } from './orcad-profile-state-telemetry'
import type { OrcadIdleStopRecord } from '../../shared/orcad-idle-exit'

const LOCAL_TERMINAL_LIST_TIMEOUT_MS = 3_000

export type OrcadHealthSurfaceHost = {
  rpc: OrcaRuntimeRpcServer
  runtimeDegradations: () => readonly RuntimeDegradation[]
  listLocalTerminals: () => Promise<readonly unknown[]>
  pairingOffer: (request: OrcadPairingOfferRequest) => Promise<ServePairingReadiness>
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } catch {
    return null
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export function createOrcadHealthSurface(options: {
  userDataPath: string
  buildVersion: string
  profileStateAuthority: OrcadProfileStateAuthoritySelection | undefined
  /** Managed launches only; see OrcadHealth.previousIdleStop. */
  previousIdleStop?: OrcadIdleStopRecord | null
  systemdNotify: SystemdNotifyEnvironment | null
}) {
  let host: OrcadHealthSurfaceHost | null = null
  let metadata: RuntimeMetadata | null = null
  const readMetadata = (): RuntimeMetadata => {
    // Why cached: re-reading the file each probe would make the runtime probe an fs probe too.
    metadata ??= readRuntimeMetadata(options.userDataPath)
    if (!metadata) {
      throw new Error('runtime metadata unavailable')
    }
    return metadata
  }
  const watchdog = new OrcadRuntimeWatchdog({
    probeRuntime: async () => {
      await sendLocalRuntimeRpcRequest({
        metadata: readMetadata(),
        method: SERVER_HEALTH_METHOD,
        params: { probe: true },
        timeoutMs: 5_000,
        maxResponseBytes: 64 * 1024,
        toError: (failure) => {
          metadata = null
          return new Error(`runtime self-probe ${failure.kind}`)
        }
      })
    },
    probeThreadpool: async () => {
      await stat(options.userDataPath)
    }
  })
  const monitor = new OrcadHealthMonitor({
    collectBase: (): Promise<OrcadHealth> =>
      collectOrcadHealth(
        options.buildVersion,
        options.profileStateAuthority,
        options.previousIdleStop
      ),
    runtimeDegradations: () => {
      try {
        return host?.runtimeDegradations() ?? []
      } catch (error) {
        // Why: a status read that throws must not fail readiness or a probe; say so and move on.
        console.error('[orcad] could not read runtime degradations for health:', error)
        return []
      }
    },
    collectStats: async () => {
      const terminals = host
        ? await withTimeout(host.listLocalTerminals(), LOCAL_TERMINAL_LIST_TIMEOUT_MS)
        : null
      const devices = host?.rpc.getDeviceRegistry()?.listDevices()
      return {
        connectedClients: host?.rpc.getMobileSocketWiring()?.connectionCount ?? null,
        pairedDevices: devices ? devices.filter((device) => device.lastSeenAt > 0).length : null,
        localTerminals: terminals ? terminals.length : null
      }
    },
    watchdog,
    boundEndpoint: () => host?.rpc.getWebSocketEndpoint() ?? null,
    underSystemdService: Boolean(process.env.INVOCATION_ID)
  })
  const notifier = options.systemdNotify
    ? new OrcadSystemdNotifier({
        send: createSystemdNotifySend(options.systemdNotify.notifySocket),
        watchdogPingMs: options.systemdNotify.watchdogPingMs,
        isLive: () => monitor.liveness().live,
        describeStatus: () => {
          const { state, degradations } = monitor.readiness()
          return degradations.length === 0
            ? state
            : `${state}; ${degradations.map((degradation) => degradation.code).join(', ')}`
        }
      })
    : null

  return {
    extraMethods: createOrcadServerAdminMethods({
      serverHealth: (request) => monitor.serverHealth(request),
      pairingOffer: async (request) => {
        if (!host) {
          throw new Error('server_not_ready')
        }
        return host.pairingOffer(request)
      }
    }),
    httpProbeHandler: createOrcadHealthProbeHandler(monitor),
    /** After the listener binds: the self-probe needs the socket and metadata. */
    attach(nextHost: OrcadHealthSurfaceHost): void {
      host = nextHost
    },
    collectInitialHealth: (): Promise<OrcadHealth> => monitor.collectInitial(),
    /** After the stdout readiness line: probes may report ready and systemd may hear READY=1. */
    async published(): Promise<void> {
      monitor.start()
      watchdog.start()
      await notifier?.ready()
    },
    async stop(): Promise<void> {
      watchdog.stop()
      monitor.stop()
      await notifier?.stopping()
    }
  }
}

export type OrcadHealthSurface = ReturnType<typeof createOrcadHealthSurface>
