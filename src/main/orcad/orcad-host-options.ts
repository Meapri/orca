/**
 * orcad flags for a self-managed host, beside the ones `orca serve` shares (OrcadOptions), and the
 * process setup they need before anything else starts.
 */
import process from 'node:process'
import { isOrcadBundledLauncherChild } from './orcad-lifecycle'
import { resolveOrcadBrowserMode, type OrcadBrowserMode } from './orcad-browser-mode'
import { applyOrcadResourceLimits } from './orcad-resource-limit-flags'
import { takeSystemdNotifyEnvironment, type SystemdNotifyEnvironment } from './orcad-systemd-notify'

export type OrcadHostOptions = {
  /** Every --pairing-address in order; the first equals pairingAddress. */
  pairingAddresses?: string[]
  /** `--pairing-expires`: unclaimed startup offers stop authenticating after this. Unset = never. */
  pairingExpiresInMs?: number
  /** `--require-port`: exit instead of falling back when the pinned --port is taken. */
  requirePort?: boolean
  /** Resource-governance env assignments from `--limit`; see orcad-resource-limit-flags.ts. */
  resourceLimits?: Record<string, string>
  /** `--browser`; unset falls back to ORCA_BROWSER_PROVIDER, then `auto`. */
  browser?: OrcadBrowserMode
  /** Serve phones through Orca Relay (outbound only); see orcad-relay.ts. */
  relay?: boolean
}

export function prepareOrcadHostProcess(options: OrcadHostOptions): {
  browserMode: OrcadBrowserMode
  systemdNotify: SystemdNotifyEnvironment | null
} {
  // Why first: the daemon launch, history sweep and browser provider all read these at start.
  applyOrcadResourceLimits(options.resourceLimits)
  return {
    browserMode: resolveOrcadBrowserMode(options.browser, process.env),
    // Why before any child: the browser sidecar, the daemon and every PTY inherit this env and
    // must not see the notify socket.
    systemdNotify: takeSystemdNotifyEnvironment(process.env, process.platform, [
      process.pid,
      ...(isOrcadBundledLauncherChild() ? [process.ppid] : [])
    ])
  }
}
