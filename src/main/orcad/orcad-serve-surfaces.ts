/**
 * What orcad serves beside the runtime RPC: the health surface (monitor, watchdog, probes,
 * `server.*` methods, sd_notify), the browser client, Orca Relay, the security log and the
 * startup pairing offers. orcad-entry calls it before the RPC server is built, once it listens,
 * and once readiness is out.
 */
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { getLocalPtyProvider } from '../ipc/pty'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { OrcadIdleStopRecord } from '../../shared/orcad-idle-exit'
import { SECURITY_LOG_FILENAME } from '../runtime/security-event-log'
import { resolveOrcadInstallRoot } from './orcad-app-paths'
import { createOrcadHealthSurface } from './orcad-health-surface'
import { startOrcadPairing } from './orcad-pairing-startup'
import { createOrcadRelayControl } from './orcad-relay'
import { resolveOrcadWebClientRoot } from './orcad-web-client-root'
import type { OrcadOptions } from './orcad-entry'
import type { OrcadProfileStateAuthoritySelection } from './orcad-profile-state-telemetry'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'
import type { SystemdNotifyEnvironment } from './orcad-systemd-notify'

export async function createOrcadServeSurfaces(input: {
  options: OrcadOptions
  profileStateAuthority: OrcadProfileStateAuthoritySelection | undefined
  previousIdleStop: OrcadIdleStopRecord | null | undefined
  systemdNotify: SystemdNotifyEnvironment | null
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
}) {
  const { options } = input
  const userDataPath = getAppEnvironment().getPath('userData')
  const buildVersion = getAppEnvironment().getVersion()
  const healthSurface = createOrcadHealthSurface({ ...input, userDataPath, buildVersion })
  const webClient = await resolveOrcadWebClientRoot(resolveOrcadInstallRoot())
  if ('reason' in webClient) {
    console.error(`[orcad] browser client not served: ${webClient.reason}`)
  }
  const relayControl = createOrcadRelayControl({
    enabled: options.relay === true,
    userDataPath,
    appVersion: buildVersion
  })
  return {
    rpcOptions: {
      extraMethods: [...healthSurface.extraMethods, ...relayControl.methods],
      httpProbeHandler: healthSurface.httpProbeHandler,
      securityLogPath: join(getAppEnvironment().getPath('logs'), SECURITY_LOG_FILENAME),
      // Same static handler and path allowlist as `orca serve`; runtime offers then carry webClientUrl.
      ...(webClient.root ? { webClientRoot: webClient.root } : {}),
      // Opt-in: managed SSH launches read the bound port back and rely on the fallback.
      ...(options.port !== undefined && options.requirePort ? { requirePinnedWsPort: true } : {})
    },
    /** Once the RPC server listens; its stops are registered to run before the server's own. */
    async attach(rpc: OrcaRuntimeRpcServer, runtime: OrcaRuntimeService, bindHost: string) {
      input.registerCleanup(() => healthSurface.stop())
      input.registerCleanup(() => relayControl.stop())
      relayControl.attach(rpc)
      const pairing = await startOrcadPairing(rpc, bindHost, options)
      healthSurface.attach({
        rpc,
        runtimeDegradations: () => runtime.getStatus().degradations ?? [],
        listLocalTerminals: () => getLocalPtyProvider().listProcesses(),
        pairingOffer: pairing.offer
      })
      return pairing
    },
    collectInitialHealth: () => healthSurface.collectInitialHealth(),
    /** After the stdout readiness line: probes may report ready and systemd may hear READY=1. */
    published: () => healthSurface.published()
  }
}
