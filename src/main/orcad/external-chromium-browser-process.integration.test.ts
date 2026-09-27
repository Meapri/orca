import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'

const executablePath = process.env.ORCA_BROWSER_EXECUTABLE

// Why 120s rather than the 30s global default: one macOS run took 30s and timed out,
// while a Linux run with an empty ~/.agent-browser was 2.8s — so the cost looks like a
// one-time Gatekeeper/codesign verification of the Rust binary, not a Linux cold start.
// Sized for the slow observation anyway: headroom on a passing test is free, and a
// timeout here would land as a flaky required check.
const COLD_BROWSER_START_TIMEOUT_MS = 120_000

const commandHost: RuntimeBrowserCommandHost = {
  getAgentBrowserBridge: () => null,
  resolveWorktreeSelector: async (selector) => ({ id: selector }),
  resolveBrowserWorkspace: async (selector) => ({ id: selector }),
  // Unused by the sidecar command paths under test; the daemon's real host is
  // OrcaRuntimeService, which owns the client-hosted registries.
  resolveBrowserNetworkExecutionHost: () => {
    throw new Error('No browser network execution host')
  },
  getBrowserHostLeaseRegistry: () => {
    throw new Error('No browser host lease registry')
  },
  getRuntimeBrowserPageRegistry: () => {
    throw new Error('No runtime browser page registry')
  },
  getAuthoritativeWindow: () => {
    throw new Error('No renderer')
  },
  getAvailableAuthoritativeWindow: () => null,
  getOffscreenBrowserBackend: () => null
}

/** PIDs of the Chromium browser processes (not renderers) running on this profile. */
async function browserMainPids(profilePath: string): Promise<number[]> {
  const listing = await runProcess({ program: 'ps', args: ['-axo', 'pid=,command='] })
  return listing.stdout
    .split('\n')
    .filter((line) => line.includes(`--user-data-dir=${profilePath}`) && !line.includes('--type='))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

describe('ExternalChromiumBrowserProcess integration', () => {
  it.runIf(Boolean(executablePath))(
    'navigates, evaluates, and screenshots with the operator executable',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orcad-external-browser-'))
      const fixturePath = join(root, 'fixture.html')
      await writeFile(
        fixturePath,
        '<!doctype html><title>External Chromium</title><main>external-ready</main>'
      )
      const provider = await resolveOrcadBrowserProvider({
        userDataPath: root,
        environment: { ORCA_BROWSER_EXECUTABLE: executablePath },
        resolveInstalledElectronExecutable: async () => null
      })
      try {
        expect(provider?.kind).toBe('chromium')
        if (!provider) {
          throw new Error('External Chromium provider did not resolve.')
        }
        const commands = provider.factory(commandHost)
        await expect(
          commands.browserTabCreate({ page: 'external-page', url: 'about:blank' })
        ).resolves.toEqual({ browserPageId: 'external-page' })
        await expect(
          commands.browserGoto({
            page: 'external-page',
            url: pathToFileURL(fixturePath).href
          })
        ).resolves.toMatchObject({ title: 'External Chromium' })
        await expect(
          commands.browserEval({
            page: 'external-page',
            expression: 'document.querySelector("main")?.textContent'
          })
        ).resolves.toMatchObject({ result: 'external-ready' })
        await expect(
          commands.browserScreenshot({ page: 'external-page', format: 'png' })
        ).resolves.toMatchObject({ data: expect.stringMatching(/\S+/), format: 'png' })
      } finally {
        await provider?.stop()
        await rm(root, { recursive: true, force: true })
      }
    },
    COLD_BROWSER_START_TIMEOUT_MS
  )

  // Why a real kill: #16084 is a Chromium death taking the runtime with it. This process is the
  // runtime here, so surviving the kill and serving the next command is the isolation proof.
  it.runIf(Boolean(executablePath) && process.platform !== 'win32')(
    'survives a killed Chromium and serves the next command from a relaunched browser',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orcad-external-browser-kill-'))
      const provider = await resolveOrcadBrowserProvider({
        userDataPath: root,
        environment: { ORCA_BROWSER_EXECUTABLE: executablePath },
        resolveInstalledElectronExecutable: async () => null
      })
      try {
        if (!provider) {
          throw new Error('External Chromium provider did not resolve.')
        }
        const commands = provider.factory(commandHost)
        await commands.browserTabCreate({ page: 'before-kill', url: 'about:blank' })
        const pids = await browserMainPids(join(root, 'browser-chromium'))
        expect(pids.length).toBeGreaterThan(0)
        for (const pid of pids) {
          process.kill(pid, 'SIGKILL')
        }

        // A few commands may fail while the driver notices; none may take this process down.
        let created: unknown = null
        const deadline = Date.now() + 60_000
        while (!created && Date.now() < deadline) {
          created = await commands
            .browserTabCreate({ page: 'after-kill', url: 'about:blank' })
            .catch(() => null)
          if (!created) {
            await new Promise((resolve) => setTimeout(resolve, 1_000))
          }
        }
        expect(created).toEqual({ browserPageId: 'after-kill' })
        expect(provider.isAvailable()).toBe(true)
        await expect(
          commands.browserEval({ page: 'after-kill', expression: '1 + 1' })
        ).resolves.toMatchObject({ result: 2 })
        const relaunched = await browserMainPids(join(root, 'browser-chromium'))
        expect(relaunched.some((pid) => pids.includes(pid))).toBe(false)
      } finally {
        await provider?.stop()
        await rm(root, { recursive: true, force: true })
      }
    },
    COLD_BROWSER_START_TIMEOUT_MS
  )

  // Why a real kill of the driver, not the browser: its Chromium tree is re-parented and keeps
  // the profile locked, so only a reap on relaunch leaves a browser the new driver can own.
  it.runIf(Boolean(executablePath) && process.platform !== 'win32')(
    'reaps the Chromium tree a killed driver left behind when orcad relaunches it',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orcad-external-browser-driver-kill-'))
      const profilePath = join(root, 'browser-chromium')
      const resolveProvider = () =>
        resolveOrcadBrowserProvider({
          userDataPath: root,
          environment: { ORCA_BROWSER_EXECUTABLE: executablePath },
          resolveInstalledElectronExecutable: async () => null
        })
      let relaunched: Awaited<ReturnType<typeof resolveProvider>> = null
      const first = await resolveProvider()
      try {
        if (!first) {
          throw new Error('External Chromium provider did not resolve.')
        }
        await first.factory(commandHost).browserTabCreate({ page: 'first', url: 'about:blank' })
        const orphaned = await browserMainPids(profilePath)
        expect(orphaned.length).toBeGreaterThan(0)
        const driverPids = await parentPids(orphaned)
        for (const pid of driverPids) {
          process.kill(pid, 'SIGKILL')
        }
        await expect.poll(async () => processesAlive(driverPids), { timeout: 10_000 }).toBe(false)
        // The driver is gone and its browser is not: the leak this reap exists for.
        expect(await processesAlive(orphaned)).toBe(true)

        // A restarted orcad resolves the same provider on the same state root.
        relaunched = await resolveProvider()
        if (!relaunched) {
          throw new Error('External Chromium provider did not relaunch.')
        }
        await expect(
          relaunched
            .factory(commandHost)
            .browserTabCreate({ page: 'relaunched', url: 'about:blank' })
        ).resolves.toEqual({ browserPageId: 'relaunched' })
        await expect.poll(async () => processesAlive(orphaned), { timeout: 10_000 }).toBe(false)
      } finally {
        await relaunched?.stop()
        await first?.stop().catch(() => undefined)
        const survivors = await browserMainPids(profilePath)
        for (const pid of survivors) {
          process.kill(pid, 'SIGKILL')
        }
        await rm(root, { recursive: true, force: true })
      }
      expect(await browserMainPids(profilePath)).toEqual([])
    },
    COLD_BROWSER_START_TIMEOUT_MS
  )
})

async function parentPids(pids: readonly number[]): Promise<number[]> {
  const listing = await runProcess({ program: 'ps', args: ['-o', 'ppid=', '-p', pids.join(',')] })
  return [...new Set(listing.stdout.split('\n').map((line) => Number(line.trim())))].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 1
  )
}

async function processesAlive(pids: readonly number[]): Promise<boolean> {
  const listing = await runProcess({
    program: 'ps',
    args: ['-o', 'pid=,stat=', '-p', pids.join(',')]
  })
  return listing.stdout
    .split('\n')
    .some((line) => line.trim().length > 0 && !line.trim().split(/\s+/)[1]?.startsWith('Z'))
}
