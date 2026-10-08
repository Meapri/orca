import type { OrcadRelayReport, OrcadRelaySignInStart } from '../shared/orcad-relay-contract'

export function formatRelayReport(report: OrcadRelayReport): string {
  const lines: string[] = []
  lines.push(
    `Relay: ${report.enabled ? 'enabled' : 'not enabled (start orcad with --relay)'}${
      report.configured ? '' : ' — Orca Cloud is not configured for this build'
    }`
  )
  const account =
    report.account.state === 'connected'
      ? `signed in${report.account.email ? ` as ${report.account.email}` : ''}`
      : report.account.state === 'reconnect-required'
        ? 'sign-in expired; run `orca serve relay sign-in`'
        : 'not signed in; run `orca serve relay sign-in`'
  lines.push(`Account: ${account}`)
  if (report.account.state === 'connected') {
    lines.push(`Session storage: ${describePersistence(report.account.persistence)}`)
  }
  if (report.account.relayEntitled === false) {
    lines.push('Entitlement: this account is not entitled to Orca Relay')
  }
  // Why explain standby: the host holds a relay connection only while a relay-paired phone exists.
  lines.push(
    `Connection: ${report.relay.status}${report.relay.cellUrl ? ` (${report.relay.cellUrl})` : ''}${
      report.relay.status === 'standby' || report.relay.status === 'offline'
        ? ' — connects on demand while a phone is paired through the relay'
        : ''
    }`
  )
  if (report.lastSignIn && report.lastSignIn.outcome !== 'connected') {
    lines.push(
      `Last sign-in: ${report.lastSignIn.outcome}${report.lastSignIn.error ? ` (${report.lastSignIn.error})` : ''}`
    )
  }
  return lines.join('\n')
}

function describePersistence(persistence: OrcadRelayReport['account']['persistence']): string {
  switch (persistence) {
    case 'encrypted':
      return 'sealed by the OS keyring'
    case 'host-unsealed':
      return 'owner-only file in the data root (this host has no keyring)'
    case 'memory-only':
      return 'memory only; sign in again after a restart'
    case 'dev-plaintext':
      return 'plaintext development file'
    case 'none':
      return 'not stored'
  }
}

export function formatRelaySignInStart(
  start: Extract<OrcadRelaySignInStart, { started: true }>
): string {
  return [
    'Open this URL in a browser on any machine and sign in:',
    `  ${start.authorizeUrl}`,
    '',
    `The browser then returns to http://127.0.0.1:${start.callbackPort} on this host. From another machine, forward that port first:`,
    `  ssh -N -L ${start.callbackPort}:127.0.0.1:${start.callbackPort} <this-host>`,
    '',
    'Waiting for sign-in (5 minutes)…'
  ].join('\n')
}
