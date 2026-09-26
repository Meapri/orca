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
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { readRuntimeMetadata } from '../runtime/runtime-metadata'
import { collectOrcadHealth, type OrcadHealth } from './orcad-health'
import { OrcadHealthMonitor } from './orcad-health-monitor'
import { createOrcadHealthProbeHandler } from './orcad-health-probe-http'
import { sendLocalRuntimeRpcRequest } from './orcad-local-rpc-request'
import { OrcadRuntimeWatchdog } from './orcad-runtime-watchdog'
import { createOrcadServerAdminMethods, SERVER_HEALTH_METHOD } from './orcad-server-admin-methods'
import {
  createSystemdNotifySend,
  OrcadSystemdNotifier,
  type SystemdNotifyEnvironment
} from './orcad-systemd-notify'
import type { OrcadProfileStateAuthoritySelection } from './orcad-profile-state-telemetry'

const LOCAL_TERMINAL_LIST_TIMEOUT_MS = 3_000

export type OrcadPairingOptions = { noPairing: boolean; pairingAddress: string | undefined }

type PairingRpc = Pick<OrcaRuntimeRpcServer, 'createPairingOffer'>

/** Same offer the readiness line prints; a pending token is re-served until a device uses it. */
export function buildOrcadPairingReadiness(
  rpc: PairingRpc,
  options: OrcadPairingOptions & { rotate?: boolean }
): ServePairingReadiness {
  if (options.noPairing) {
    return {
      available: false,
      reason: 'disabled_by_operator',
      guidance: 'Restart without --no-pairing to create a client pairing offer.'
    }
  }
  const offer = rpc.createPairingOffer({
    address: options.pairingAddress,
    name: `CLI ${new Date().toLocaleDateString()}`,
    scope: 'runtime',
    ...(options.rotate ? { rotate: true } : {})
  })
  return offer.available
    ? {
        available: true,
        url: offer.pairingUrl,
        endpoint: offer.endpoint,
        deviceId: offer.deviceId,
        webClientUrl: offer.webClientUrl,
        scope: 'runtime',
        qr: null
      }
    : offer
}

export type OrcadHealthSurfaceHost = {
  rpc: OrcaRuntimeRpcServer
  runtimeDegradations: () => readonly RuntimeDegradation[]
  listLocalTerminals: () => Promise<readonly unknown[]>
  pairing: OrcadPairingOptions
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
      collectOrcadHealth(options.buildVersion, options.profileStateAuthority),
    runtimeDegradations: () => host?.runtimeDegradations() ?? [],
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
    methods: [
      ...ALL_RPC_METHODS,
      ...createOrcadServerAdminMethods({
        serverHealth: (request) => monitor.serverHealth(request),
        pairingOffer: ({ rotate }) => {
          if (!host) {
            throw new Error('server_not_ready')
          }
          return buildOrcadPairingReadiness(host.rpc, { ...host.pairing, rotate })
        }
      })
    ],
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
