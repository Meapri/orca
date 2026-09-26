/** Doctor checks answered from the listener and the running orcad's `server.health`. */
import { createServer } from 'node:net'
import process from 'node:process'
import type { OrcadDoctorCheck, OrcadDoctorInputs } from './orcad-doctor-report'

function listenProbe(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (error) =>
      resolve(error instanceof Error && 'code' in error ? String(error.code) : String(error))
    )
    server.listen(port, host, () => server.close(() => resolve(null)))
  })
}

function portOwnerCommand(port: number, platform: NodeJS.Platform): string {
  return platform === 'linux'
    ? `ss -ltnp 'sport = :${port}'`
    : platform === 'win32'
      ? `netstat -ano | findstr :${port}`
      : `lsof -nP -iTCP:${port} -sTCP:LISTEN`
}

export async function checkBind(inputs: OrcadDoctorInputs): Promise<OrcadDoctorCheck> {
  const platform = inputs.platform ?? process.platform
  const target = `${inputs.bindHost}:${inputs.port}`
  const bound = inputs.running?.boundEndpoint
  if (bound && bound.endsWith(`:${inputs.port}`)) {
    return { id: 'bind', status: 'pass', summary: `orcad is listening on ${bound}.` }
  }
  const failure = await listenProbe(inputs.bindHost, inputs.port)
  if (failure === null) {
    return { id: 'bind', status: 'pass', summary: `${target} is free to bind.` }
  }
  if (failure === 'EADDRINUSE' && inputs.running && !('boundEndpoint' in inputs.running)) {
    return {
      id: 'bind',
      status: 'warn',
      summary: `${target} is in use, most likely by the running orcad, which predates reporting its listener.`
    }
  }
  if (failure === 'EADDRINUSE') {
    return inputs.portPinned
      ? {
          id: 'bind',
          status: 'fail',
          summary: `${target} is in use; a pinned --port makes orcad exit 78 instead of moving.`,
          fix: `Find the holder: ${portOwnerCommand(inputs.port, platform)}`
        }
      : {
          id: 'bind',
          status: 'warn',
          summary: `${target} is in use; without --port orcad falls back to another port and clients must use the advertised one.`,
          fix: `Pin a free port with --port, or free it: ${portOwnerCommand(inputs.port, platform)}`
        }
  }
  if (failure === 'EADDRNOTAVAIL') {
    return {
      id: 'bind',
      status: 'fail',
      summary: `${inputs.bindHost} is not an address of this host.`,
      fix: 'Pass --bind with a local interface address (default 127.0.0.1).'
    }
  }
  return {
    id: 'bind',
    status: 'fail',
    summary: `Cannot bind ${target} (${failure}).`,
    fix: failure === 'EACCES' ? 'Use a port at or above 1024.' : undefined
  }
}

export function checkDaemonIsolation(inputs: OrcadDoctorInputs): OrcadDoctorCheck {
  const platform = inputs.platform ?? process.platform
  if (platform !== 'linux') {
    return {
      id: 'daemon-isolation',
      status: 'skip',
      summary: 'cgroup isolation applies to Linux systemd hosts only.'
    }
  }
  if (!inputs.running) {
    return {
      id: 'daemon-isolation',
      status: 'skip',
      summary: 'orcad is not answering; the daemon cgroup is read from its health.'
    }
  }
  const unit = inputs.running.health.terminalDaemon.cgroupUnit
  return unit
    ? {
        id: 'daemon-isolation',
        status: 'pass',
        summary: `The terminal daemon runs in its own scope ${unit}; a service restart keeps live terminals.`
      }
    : {
        id: 'daemon-isolation',
        status: 'warn',
        summary:
          'The terminal daemon shares the service cgroup; stopping or restarting the unit kills every live terminal.',
        fix: 'Fix the user bus and linger checks below, then restart orcad once while no terminals are live.'
      }
}

export function checkNodeAbi(inputs: OrcadDoctorInputs): OrcadDoctorCheck {
  if (!inputs.running) {
    return {
      id: 'node-abi',
      status: 'skip',
      summary: "orcad's node-pty precondition verifies the native ABI at startup."
    }
  }
  const { nodeAbi, nodeVersion } = inputs.running.health
  const terminal = (inputs.running.health.degradations ?? []).find(
    (entry) => entry.code === 'terminal_unavailable'
  )
  return terminal
    ? {
        id: 'node-abi',
        status: 'fail',
        summary: `orcad (Node ${nodeVersion}, ABI ${nodeAbi}) cannot load node-pty: ${terminal.message}`
      }
    : {
        id: 'node-abi',
        status: 'pass',
        summary: `orcad runs Node ${nodeVersion} (ABI ${nodeAbi}) and its terminals load.`
      }
}
