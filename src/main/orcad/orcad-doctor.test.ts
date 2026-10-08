import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrcadServerHealth } from './orcad-health-monitor'
import {
  checkDataRoot,
  checkInstanceLock,
  checkRuntime,
  checkSocketPath
} from './orcad-doctor-local-checks'
import { checkBind, checkDaemonIsolation, checkNodeAbi } from './orcad-doctor-server-checks'
import {
  checkDaemonScopeSupport,
  checkDiskSpace,
  checkGlibcFloor,
  checkUserLinger
} from './orcad-doctor-host-checks'
import { runOrcadDoctor, type OrcadDoctorInputs } from './orcad-doctor'

const posix = process.platform !== 'win32'
const holders: Server[] = []

afterEach(async () => {
  await Promise.all(
    holders.splice(0).map((holder) => new Promise<void>((resolve) => holder.close(() => resolve())))
  )
})

function running(overrides: Partial<OrcadServerHealth['health']> = {}): OrcadServerHealth {
  return {
    state: 'ready',
    live: true,
    boundEndpoint: 'ws://127.0.0.1:6768',
    checkedAt: new Date(0).toISOString(),
    health: {
      buildHash: 'abc',
      buildVersion: '1.0.0',
      nodeVersion: '24.1.0',
      nodeAbi: '137',
      platform: 'linux',
      arch: 'x64',
      pid: 10,
      terminalDaemon: {
        state: 'live',
        ownsFreshSessions: true,
        pid: 11,
        buildVersion: '1.0.0',
        entryPath: '/d.js',
        protocolVersion: 5,
        cgroupUnit: 'orca-daemon-x.scope',
        selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 1 }
      },
      degradations: [],
      ...overrides
    },
    stats: {
      startedAt: new Date(0).toISOString(),
      uptimeSeconds: 1,
      memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 },
      cpu: { userMs: 1, systemMs: 1 },
      connectedClients: 0,
      pairedDevices: 0,
      localTerminals: 0
    }
  }
}

function inputs(overrides: Partial<OrcadDoctorInputs> = {}): OrcadDoctorInputs {
  return {
    dataRoot: mkdtempSync(join(tmpdir(), 'orcad-doctor-')),
    bindHost: '127.0.0.1',
    port: 0,
    portPinned: true,
    running: null,
    runningError: null,
    platform: 'linux',
    ...overrides
  }
}

async function occupiedPort(): Promise<number> {
  const holder = createServer()
  holders.push(holder)
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
  const address = holder.address()
  if (!address || typeof address === 'string') {
    throw new Error('holder did not bind')
  }
  return address.port
}

describe('local doctor checks', () => {
  it('passes a missing data root that orcad will create, and warns on a shared one', () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-doctor-'))
    expect(checkDataRoot(join(root, 'absent')).status).toBe('pass')
    if (posix) {
      chmodSync(root, 0o755)
      expect(checkDataRoot(root)).toMatchObject({ status: 'warn', fix: `chmod 700 '${root}'` })
      chmodSync(root, 0o700)
      expect(checkDataRoot(root).status).toBe('pass')
    }
  })

  const LOCK_RECORD = {
    startedAtMs: null,
    version: '0.1.0',
    acquiredAt: '2026-10-01T00:00:00.000Z',
    nonce: 'doctor-fixture'
  }

  it('fails a lock owned by another identity and marks a silent live holder unverifiable', () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-doctor-'))
    writeFileSync(
      join(root, 'orcad.lock'),
      JSON.stringify({ ...LOCK_RECORD, pid: process.pid, identity: 'someone-else' })
    )
    expect(checkInstanceLock(root, null).status).toBe('fail')

    const identity = String(process.getuid?.() ?? '')
    if (posix) {
      writeFileSync(
        join(root, 'orcad.lock'),
        JSON.stringify({ ...LOCK_RECORD, pid: process.pid, identity })
      )
      const silent = checkInstanceLock(root, null)
      expect(silent.status).toBe('warn')
      expect(silent.summary).toContain('unverifiable')
      expect(checkInstanceLock(root, running()).status).toBe('pass')
    }
  })

  it('fails a data root too long for a unix socket path, per platform limit', () => {
    const long = `/${'d'.repeat(85)}`
    expect(checkSocketPath(long, 'darwin').status).toBe('fail')
    expect(checkSocketPath(long, 'linux').status).toBe('pass')
    expect(checkSocketPath('/home/orca/.orca', 'darwin').status).toBe('pass')
    expect(checkSocketPath(long, 'win32').status).toBe('skip')
  })

  it('tells an older runtime apart from no runtime at all', () => {
    expect(checkRuntime(inputs({ runningError: 'method_not_found' })).status).toBe('warn')
    expect(checkRuntime(inputs()).status).toBe('skip')
    expect(
      checkRuntime(
        inputs({
          running: running({
            degradations: [
              {
                code: 'runtime_unresponsive',
                severity: 'critical',
                component: 'runtime',
                message: 'stuck'
              }
            ]
          })
        })
      ).status
    ).toBe('fail')
  })
})

describe('server doctor checks', () => {
  it('fails a pinned port in use but only warns when orcad may fall back', async () => {
    const port = await occupiedPort()
    expect((await checkBind(inputs({ port, portPinned: true }))).status).toBe('fail')
    expect((await checkBind(inputs({ port, portPinned: false }))).status).toBe('warn')
  })

  it('passes a port orcad itself holds, and a free one', async () => {
    const port = await occupiedPort()
    const self = running()
    self.boundEndpoint = `ws://127.0.0.1:${port}`
    expect((await checkBind(inputs({ port, running: self }))).status).toBe('pass')
    expect((await checkBind(inputs({ port: 0 }))).status).toBe('pass')
  })

  it('warns when the daemon shares the service cgroup on Linux only', () => {
    const unscoped = running({
      terminalDaemon: { ...running().health.terminalDaemon, cgroupUnit: null }
    })
    expect(checkDaemonIsolation(inputs({ running: unscoped })).status).toBe('warn')
    expect(checkDaemonIsolation(inputs({ running: running() })).status).toBe('pass')
    expect(checkDaemonIsolation(inputs({ running: unscoped, platform: 'darwin' })).status).toBe(
      'skip'
    )
  })

  it('fails the ABI check only when the running orcad reports terminals unavailable', () => {
    expect(checkNodeAbi(inputs({ running: running() })).status).toBe('pass')
    const broken = running({
      degradations: [
        {
          code: 'terminal_unavailable',
          severity: 'critical',
          component: 'terminal',
          message: 'abi mismatch'
        }
      ]
    })
    expect(checkNodeAbi(inputs({ running: broken })).status).toBe('fail')
  })
})

describe('host doctor checks', () => {
  it('turns a missing user bus into the linger fix', () => {
    expect(checkDaemonScopeSupport('linux', () => 'no_user_bus')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('loginctl enable-linger')
    })
    expect(checkDaemonScopeSupport('linux', () => 'user_manager_ends_with_session')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('loginctl enable-linger')
    })
    expect(checkDaemonScopeSupport('linux', () => 'supported').status).toBe('pass')
  })

  it('reads linger from the systemd linger directory', () => {
    const withLinger = () => true
    const withoutLinger = (path: string) => !path.startsWith('/var/lib/systemd/linger')
    expect(checkUserLinger('linux', withLinger, 'orca').status).toBe('pass')
    expect(checkUserLinger('linux', withoutLinger, 'orca')).toMatchObject({
      status: 'warn',
      fix: 'sudo loginctl enable-linger orca'
    })
    expect(checkUserLinger('darwin', withLinger, 'orca').status).toBe('skip')
  })

  it('fails glibc below the floor and passes at or above it', () => {
    expect(checkGlibcFloor('linux', { libc: 'glibc', glibcVersion: '2.28' }).status).toBe('fail')
    expect(checkGlibcFloor('linux', { libc: 'glibc', glibcVersion: '2.31' }).status).toBe('pass')
    expect(checkGlibcFloor('linux', { libc: 'musl', glibcVersion: null }).status).toBe('pass')
    expect(checkGlibcFloor('darwin', { libc: 'none', glibcVersion: null }).status).toBe('skip')
  })

  it('grades free disk space against the data root', async () => {
    const root = '/srv/orca/data'
    const exists = (path: string) => path === '/srv'
    const probed: string[] = []
    const free = (bytes: number) => async (path: string) => {
      probed.push(path)
      return bytes
    }
    expect((await checkDiskSpace(root, free(100 * 1024 ** 2), exists)).status).toBe('fail')
    expect((await checkDiskSpace(root, free(1024 ** 3), exists)).status).toBe('warn')
    expect((await checkDiskSpace(root, free(50 * 1024 ** 3), exists)).status).toBe('pass')
    expect(probed).toEqual(['/srv', '/srv', '/srv'])
  })
})

describe('runOrcadDoctor', () => {
  it('reports every check in a stable order', async () => {
    const report = await runOrcadDoctor(inputs({ platform: 'darwin' }))
    expect(report.map((check) => check.id)).toEqual([
      'data-root',
      'socket-path',
      'instance-lock',
      'runtime',
      'bind',
      'systemd-user-scope',
      'systemd-linger',
      'daemon-isolation',
      'glibc',
      'node-abi',
      'disk-space'
    ])
  })
})
