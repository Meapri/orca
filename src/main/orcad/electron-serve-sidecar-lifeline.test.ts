import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  electronServeSidecarLifelineSpec,
  startElectronServeSidecarLifeline
} from './electron-serve-sidecar-lifeline'

const OWNER_FIXTURE = join(import.meta.dirname, '__fixtures__', 'fake-orcad-lifeline-owner.cjs')
// Why a helper child: the reap must reach the whole group, like Electron's GPU/renderer helpers.
const SIDECAR_SCRIPT = `
const { spawn } = require('node:child_process');
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(process.env.HELPER_PID_FILE, String(helper.pid));
setInterval(() => {}, 1000);
`
const REAP_BOUND_MS = 10_000
const OwnerReport = z.object({ watcherPid: z.number() })

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killQuietly(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await delay(50)
  }
  return predicate()
}

function readHelperPid(path: string): number {
  try {
    return Number(readFileSync(path, 'utf8')) || 0
  } catch {
    return 0
  }
}

async function startFakeSidecar(): Promise<{
  sidecar: ChildProcess
  helperPid: number
  dataDir: string
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'orcad-browser-lifeline-'))
  const helperPidFile = join(dataDir, 'helper.pid')
  const sidecar = spawn(process.execPath, ['-e', SIDECAR_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HELPER_PID_FILE: helperPidFile }
  })
  const sidecarPid = sidecar.pid!
  cleanups.push(async () => {
    killQuietly(-sidecarPid)
    await rm(dataDir, { recursive: true, force: true })
  })
  expect(await waitFor(() => readHelperPid(helperPidFile) > 0, 5_000)).toBe(true)
  const helperPid = readHelperPid(helperPidFile)
  cleanups.push(() => killQuietly(helperPid))
  return { sidecar, helperPid, dataDir }
}

describe.skipIf(process.platform === 'win32')('Electron sidecar lifeline', () => {
  it('reaps the sidecar group and its profile within a bound after orcad is SIGKILLed', async () => {
    const { sidecar, helperPid, dataDir } = await startFakeSidecar()
    const sidecarExited = new Promise<void>((resolve) => sidecar.once('exit', () => resolve()))
    const spec = electronServeSidecarLifelineSpec({
      sidecarPid: sidecar.pid!,
      sidecarDataPath: dataDir,
      graceMs: 500
    })
    const owner = spawn(process.execPath, [OWNER_FIXTURE], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ORCAD_LIFELINE_SPEC: JSON.stringify(spec) }
    })
    cleanups.push(() => killQuietly(owner.pid!))
    const firstLine = await new Promise<string>((resolve) =>
      owner.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()))
    )
    const { watcherPid } = OwnerReport.parse(JSON.parse(firstLine))
    cleanups.push(() => killQuietly(watcherPid))
    await delay(300)
    expect(isLive(sidecar.pid!)).toBe(true)

    const killedAt = Date.now()
    owner.kill('SIGKILL')

    await Promise.race([sidecarExited, delay(REAP_BOUND_MS)])
    expect(sidecar.exitCode !== null || sidecar.signalCode !== null).toBe(true)
    expect(await waitFor(() => !isLive(helperPid), REAP_BOUND_MS)).toBe(true)
    expect(await waitFor(() => !existsSync(dataDir), REAP_BOUND_MS)).toBe(true)
    expect(await waitFor(() => !isLive(watcherPid), REAP_BOUND_MS)).toBe(true)
    expect(Date.now() - killedAt).toBeLessThan(REAP_BOUND_MS)
  }, 30_000)

  it('leaves the sidecar alone after a graceful release', async () => {
    const { sidecar, dataDir } = await startFakeSidecar()
    const lifeline = startElectronServeSidecarLifeline({
      sidecarPid: sidecar.pid!,
      sidecarDataPath: dataDir,
      graceMs: 500
    })
    expect(lifeline).not.toBeNull()
    await delay(300)

    lifeline!.release()
    await delay(1_500)

    expect(isLive(sidecar.pid!)).toBe(true)
    expect(existsSync(dataDir)).toBe(true)
  }, 15_000)
})
