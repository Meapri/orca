/** OS-level process control for the Electron `--serve` browser sidecar orcad launches. */
import { createServer } from 'node:net'

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
export function electronServeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of [
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
  return environment
}

export function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // The sidecar already exited.
  }
}

export function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
