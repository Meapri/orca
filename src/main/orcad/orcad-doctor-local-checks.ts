/** Doctor checks that read the data root directly, so they answer even when orcad cannot start. */
import { accessSync, constants, statSync } from 'node:fs'
import process from 'node:process'
import { inspectOrcadInstanceLock } from './orcad-instance-lock'
import type { OrcadServerHealth } from '../../shared/orcad-server-health-contract'
import type { OrcadDoctorCheck, OrcadDoctorInputs } from './orcad-doctor-report'

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export function checkDataRoot(dataRoot: string, platform = process.platform): OrcadDoctorCheck {
  let stats
  try {
    stats = statSync(dataRoot)
  } catch (error) {
    return isErrorCode(error, 'ENOENT')
      ? {
          id: 'data-root',
          status: 'pass',
          summary: `${dataRoot} does not exist yet; orcad creates it (mode 0700) on first start.`
        }
      : {
          id: 'data-root',
          status: 'fail',
          summary: `Cannot stat ${dataRoot}: ${String(error)}`,
          fix: 'Point ORCA_USER_DATA at a directory this account can create.'
        }
  }
  if (!stats.isDirectory()) {
    return {
      id: 'data-root',
      status: 'fail',
      summary: `${dataRoot} is not a directory.`,
      fix: 'Move it aside or set ORCA_USER_DATA to a directory.'
    }
  }
  try {
    accessSync(dataRoot, constants.W_OK)
  } catch {
    return {
      id: 'data-root',
      status: 'fail',
      summary: `${dataRoot} is not writable by this account.`,
      fix: `sudo chown -R "$(id -u)" '${dataRoot}'`
    }
  }
  if (platform === 'win32') {
    return {
      id: 'data-root',
      status: 'pass',
      summary: `${dataRoot} is writable (ownership is ACL-based on Windows).`
    }
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) {
    return {
      id: 'data-root',
      status: 'fail',
      summary: `${dataRoot} is owned by uid ${stats.uid}, not ${uid}; orcad refuses it (exit 78).`,
      fix: `sudo chown -R ${uid} '${dataRoot}'  # or give this account its own ORCA_USER_DATA`
    }
  }
  if ((stats.mode & 0o077) !== 0) {
    return {
      id: 'data-root',
      status: 'warn',
      summary: `${dataRoot} is mode ${(stats.mode & 0o777).toString(8)}; orcad tightens it to 0700 on start because credentials live there unsealed.`,
      fix: `chmod 700 '${dataRoot}'`
    }
  }
  return {
    id: 'data-root',
    status: 'pass',
    summary: `${dataRoot} is private (0700) and owned by this account.`
  }
}

export function checkInstanceLock(
  dataRoot: string,
  running: OrcadServerHealth | null
): OrcadDoctorCheck {
  const lock = inspectOrcadInstanceLock(dataRoot)
  switch (lock.state) {
    case 'free':
      return { id: 'instance-lock', status: 'pass', summary: 'No orcad holds this data root.' }
    case 'stale':
      return {
        id: 'instance-lock',
        status: 'pass',
        summary: `A stale lock${lock.record ? ` from dead pid ${lock.record.pid}` : ''} remains; the next start reclaims it.`
      }
    case 'foreign':
      return {
        id: 'instance-lock',
        status: 'fail',
        summary: `The lock belongs to identity ${lock.record.identity} (pid ${lock.record.pid}); orcad refuses to share a data root across accounts.`,
        fix: 'Run orcad as that account, or give this account its own ORCA_USER_DATA.'
      }
    case 'held':
      return running
        ? {
            id: 'instance-lock',
            status: 'pass',
            summary: `Held by the running orcad (pid ${lock.record.pid}).`
          }
        : {
            id: 'instance-lock',
            status: 'warn',
            summary: `Held by live pid ${lock.record.pid}, which did not answer server.health; its state is unverifiable.`,
            fix: `Inspect it: ps -o pid,lstart,command -p ${lock.record.pid}`
          }
  }
}

export function checkRuntime(inputs: OrcadDoctorInputs): OrcadDoctorCheck {
  if (inputs.running) {
    const critical = (inputs.running.health.degradations ?? []).filter(
      (entry) => entry.severity === 'critical'
    )
    return critical.length === 0
      ? {
          id: 'runtime',
          status: 'pass',
          summary: `orcad answers: ${inputs.running.state}, ${inputs.running.live ? 'live' : 'wedged'}.`
        }
      : {
          id: 'runtime',
          status: 'fail',
          summary: `orcad answers but is ${inputs.running.state}: ${critical.map((entry) => entry.message).join(' ')}`,
          fix: 'Run `orca serve status` for the full verdict.'
        }
  }
  if (inputs.runningError === 'method_not_found') {
    return {
      id: 'runtime',
      status: 'warn',
      summary:
        'A runtime answers but does not publish server.health: it is the desktop app or an orcad older than this CLI.',
      fix: 'Update orcad on this host to get continuous health.'
    }
  }
  return {
    id: 'runtime',
    status: 'skip',
    summary: `No orcad answered on this data root${inputs.runningError ? ` (${inputs.runningError})` : ''}; server-side checks skipped.`
  }
}

// Why: `sun_path` is 104 bytes on macOS and 108 on Linux; a longer root binds nothing the CLI can dial.
// Names are `o-<pid>-<4>.sock`, sized for each kernel's largest pid (99998 vs pid_max 4194304).
const SOCKET_PATH_BUDGET: Partial<Record<NodeJS.Platform, { limit: number; longestName: number }>> =
  {
    darwin: { limit: 103, longestName: 'o-99998-abcd.sock'.length },
    linux: { limit: 107, longestName: 'o-4194304-abcd.sock'.length }
  }

export function checkSocketPath(dataRoot: string, platform = process.platform): OrcadDoctorCheck {
  const budget = SOCKET_PATH_BUDGET[platform]
  if (budget === undefined) {
    return { id: 'socket-path', status: 'skip', summary: 'This platform uses named pipes.' }
  }
  const { limit } = budget
  const longest = dataRoot.length + 1 + budget.longestName
  return longest <= limit
    ? {
        id: 'socket-path',
        status: 'pass',
        summary: `The local RPC socket path fits (${longest}/${limit} bytes).`
      }
    : {
        id: 'socket-path',
        status: 'fail',
        summary: `The local RPC socket path can reach ${longest} bytes, over the ${limit}-byte limit; the CLI cannot reach orcad.`,
        fix: 'Point ORCA_USER_DATA at a shorter path, e.g. ~/.orca.'
      }
}
