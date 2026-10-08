/** OS-level process control for the Electron `--serve` browser sidecar orcad launches. */
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const STOP_TIMEOUT_MS = 5_000

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
  if (!address || typeof address === 'string') {
    throw new Error('Loopback listener reported no TCP port.')
  }
  return address.port
}
export function electronServeEnvironment(userDataPath: string): NodeJS.ProcessEnv {
  // Why ORCA_BACKGROUND_LAUNCH: the sidecar is a windowless automation host; on macOS this
  // drops its Dock tile and menu bar so it never steals focus or leaves a ghost icon.
  const environment: NodeJS.ProcessEnv = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  for (const key of [
    'ORCA_E2E_USER_DATA_DIR',
    'ORCA_USER_DATA',
    'ORCA_USER_DATA_PATH',
    'AGENT_BROWSER_ARGS',
    'AGENT_BROWSER_AUTO_CONNECT',
    'AGENT_BROWSER_CDP',
    'AGENT_BROWSER_ENGINE',
    'AGENT_BROWSER_EXECUTABLE_PATH',
    'AGENT_BROWSER_HEADED',
    'AGENT_BROWSER_PROFILE',
    'AGENT_BROWSER_PROVIDER',
    'AGENT_BROWSER_SESSION',
    'AGENT_BROWSER_SESSION_NAME',
    'AGENT_BROWSER_STATE'
  ]) {
    delete environment[key]
  }
  // Keep Electron's native home override active in isolated sidecars.
  if (process.env.ORCA_E2E_USER_DATA_DIR || process.env.ORCA_E2E_HOME_DIR) {
    environment.ORCA_E2E_USER_DATA_DIR = userDataPath
  }
  return environment
}

export function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // The sidecar already exited.
  }
}

/** POSIX signals the sidecar's whole group (it is spawned detached); Windows the root only. */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // No such group: fall back to the pid itself.
    }
  }
  signalProcess(pid, signal)
}

export function processGroupIsLive(pid: number): boolean {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      // No such group: ask about the pid itself.
    }
  }
  return processIsLive(pid)
}

export function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** SIGTERM the sidecar's group, then SIGKILL whatever is left after the grace period. */
export async function terminateElectronServeSidecar(pid: number): Promise<void> {
  signalProcessGroup(pid, 'SIGTERM')
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (processIsLive(pid) && Date.now() < deadline) {
    await delay(50)
  }
  if (processGroupIsLive(pid)) {
    signalProcessGroup(pid, 'SIGKILL')
  }
}
