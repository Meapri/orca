// Human output for `orca serve status | doctor | pairing`.
import type {
  OrcadPairingOfferReport,
  OrcadServerHealth
} from '../shared/orcad-server-health-contract'
import type { OrcadDoctorCheck } from '../main/orcad/orcad-doctor-report'

function mebibytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 2)} MiB`
}

function duration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function countOrUnverifiable(value: number | null, noun: string): string {
  return value === null ? `${noun}: unverifiable` : `${value} ${noun}`
}

// Why Linux only for "unscoped": cgroup scopes exist only there, so elsewhere it is not a finding.
function describeDaemonPlacement(
  pid: number | null,
  cgroupUnit: string | null,
  platform: string
): string {
  const parts = [
    ...(pid ? [`pid ${pid}`] : []),
    ...(cgroupUnit ? [`scope ${cgroupUnit}`] : platform === 'linux' ? ['unscoped'] : [])
  ]
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

export function formatServeStatus(status: OrcadServerHealth): string {
  const { health, stats } = status
  const daemon = health.terminalDaemon
  const watchdog = health.watchdog
  const verdict = `${status.state === 'ready' ? 'ready' : status.state.toUpperCase()}, ${status.live ? 'live' : 'WEDGED'}`
  const lines = [
    `orcad: ${verdict}`,
    `Build: ${health.buildVersion} (${health.buildHash}) · Node ${health.nodeVersion} ABI ${health.nodeAbi} · ${health.platform}/${health.arch} · pid ${health.pid}`,
    `Listener: ${status.boundEndpoint ?? 'unavailable'}`,
    `Uptime: ${duration(stats.uptimeSeconds)} (since ${stats.startedAt}) · RSS ${mebibytes(stats.memory.rssBytes)} · heap used ${mebibytes(stats.memory.heapUsedBytes)} · CPU user ${(stats.cpu.userMs / 1000).toFixed(1)}s sys ${(stats.cpu.systemMs / 1000).toFixed(1)}s`
  ]
  if (watchdog) {
    lines.push(
      `Event loop: lag ${Math.round(watchdog.eventLoop.lagMs)}ms, max ${Math.round(watchdog.eventLoop.maxLagMs)}ms over ${Math.round(watchdog.eventLoop.windowMs / 1000)}s · runtime probe ${watchdog.runtimeProbe.state} · I/O probe ${watchdog.threadpoolProbe.state}`
    )
  }
  lines.push(
    `Terminal daemon: ${daemon.state}${describeDaemonPlacement(daemon.pid, daemon.cgroupUnit, health.platform)} · self-test ${daemon.selfTest.verdict} (${daemon.selfTest.coverage}, ${daemon.selfTest.durationMs}ms) at ${status.checkedAt}`,
    `Clients: ${countOrUnverifiable(stats.connectedClients, 'connected')} · ${countOrUnverifiable(stats.pairedDevices, 'paired devices')} · ${countOrUnverifiable(stats.localTerminals, 'local terminals')}`
  )
  const degradations = health.degradations ?? []
  if (degradations.length === 0) {
    lines.push('Degradations: none')
  } else {
    lines.push('Degradations:')
    for (const degradation of degradations) {
      lines.push(`  [${degradation.severity}] ${degradation.code}: ${degradation.message}`)
    }
  }
  return lines.join('\n')
}

const DOCTOR_LABELS: Record<OrcadDoctorCheck['status'], string> = {
  pass: 'ok  ',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'skip'
}

export function formatServeDoctor(report: {
  dataRoot: string
  checks: OrcadDoctorCheck[]
}): string {
  const lines = [`orcad doctor — data root ${report.dataRoot}`, '']
  for (const check of report.checks) {
    lines.push(`${DOCTOR_LABELS[check.status]}  ${check.id.padEnd(18)} ${check.summary}`)
    if (check.fix && check.status !== 'pass' && check.status !== 'skip') {
      lines.push(`      fix: ${check.fix}`)
    }
  }
  const failed = report.checks.filter((check) => check.status === 'fail').length
  const warned = report.checks.filter((check) => check.status === 'warn').length
  lines.push('', `${failed} failed, ${warned} warning${warned === 1 ? '' : 's'}.`)
  return lines.join('\n')
}

export function formatServePairing(pairing: OrcadPairingOfferReport, qr: string | null): string {
  if (!pairing.available) {
    return `Pairing unavailable: ${pairing.reason}\n${pairing.guidance}`
  }
  const lines = [`Pairing URL: ${pairing.url}`, `Endpoint: ${pairing.endpoint}`]
  if (pairing.webClientUrl) {
    lines.push(`Web client URL: ${pairing.webClientUrl}`)
  }
  if (qr) {
    lines.push('', qr)
  }
  lines.push('', 'Anyone holding this link can pair until a device uses it; `--rotate` revokes it.')
  return lines.join('\n')
}
