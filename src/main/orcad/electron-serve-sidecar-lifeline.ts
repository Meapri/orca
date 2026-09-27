/**
 * Ties the Electron browser sidecar's lifetime to orcad's.
 *
 * Why a separate watcher process: orcad killed with SIGKILL runs no cleanup, and the installed
 * desktop app it drives cannot be taught to watch its parent. The watcher holds the read end of
 * a pipe only orcad writes to; the kernel closes it when orcad dies, however it dies, and the
 * watcher then kills the sidecar's whole process group and removes its temp profile.
 */
import {
  spawnProcess,
  type ProcessSpec,
  type SpawnedProcess
} from '../../shared/child-process/run-process'

// Why inline: the watcher must run from orcad's own runtime binary without a file on disk.
const LIFELINE_SCRIPT = `
const pid = Number(process.env.ORCAD_SIDECAR_PID);
const dataDir = process.env.ORCAD_SIDECAR_DATA_DIR || '';
const graceMs = Number(process.env.ORCAD_SIDECAR_GRACE_MS) || 3000;
const alive = () => { try { process.kill(pid, 0); return true } catch { return false } };
const signal = (name) => {
  try { process.kill(-pid, name) } catch {}
  try { process.kill(pid, name) } catch {}
};
let settled = false;
const release = () => { settled = true; process.exit(0) };
const reap = () => {
  if (settled) return;
  settled = true;
  signal('SIGTERM');
  const startedAt = Date.now();
  const poll = setInterval(() => {
    if (alive() && Date.now() - startedAt < graceMs) return;
    clearInterval(poll);
    signal('SIGKILL');
    if (dataDir) { try { require('node:fs').rmSync(dataDir, { recursive: true, force: true }) } catch {} }
    process.exit(0);
  }, 100);
};
process.stdin.on('data', (chunk) => { if (String(chunk).includes('release')) release() });
process.stdin.on('end', reap);
process.stdin.on('close', reap);
process.stdin.on('error', reap);
process.stdin.resume();
setInterval(() => { if (!settled && !alive()) release() }, 1000);
`

export type ElectronServeSidecarLifeline = {
  /** Graceful stop: the caller already stopped the sidecar, so the watcher exits without killing. */
  release(): void
}

export type ElectronServeSidecarLifelineOptions = {
  sidecarPid: number
  sidecarDataPath: string
  graceMs?: number
  /** The runtime that runs the watcher; orcad's own Node or Bun binary. */
  runtimeExecutable?: string
}

export function electronServeSidecarLifelineSpec(
  options: ElectronServeSidecarLifelineOptions
): ProcessSpec {
  return {
    program: options.runtimeExecutable ?? process.execPath,
    args: ['-e', LIFELINE_SCRIPT],
    env: {
      ...process.env,
      ORCAD_SIDECAR_PID: String(options.sidecarPid),
      ORCAD_SIDECAR_DATA_DIR: options.sidecarDataPath,
      ORCAD_SIDECAR_GRACE_MS: String(options.graceMs ?? 3_000)
    },
    // Why its own group: a signal to orcad's group (Ctrl-C, a supervisor) must not take the
    // watcher down before it has reaped the sidecar.
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore']
  }
}

/** POSIX only: process groups are what make a group kill reach the sidecar's helpers. */
export function startElectronServeSidecarLifeline(
  options: ElectronServeSidecarLifelineOptions
): ElectronServeSidecarLifeline | null {
  if (process.platform === 'win32') {
    return null
  }
  let watcher: SpawnedProcess
  try {
    watcher = spawnProcess(electronServeSidecarLifelineSpec(options))
  } catch (error) {
    console.warn('[orcad] Browser sidecar lifeline unavailable:', error)
    return null
  }
  watcher.once('error', (error) => console.warn('[orcad] Browser sidecar lifeline failed:', error))
  watcher.stdin?.on('error', () => undefined)
  // Why unref: the watcher must never keep orcad's event loop alive on its own.
  watcher.unref()
  const stdin = watcher.stdin
  if (stdin && 'unref' in stdin && typeof stdin.unref === 'function') {
    stdin.unref()
  }
  let released = false
  return {
    release: () => {
      if (released) {
        return
      }
      released = true
      stdin?.end('release\n')
    }
  }
}
