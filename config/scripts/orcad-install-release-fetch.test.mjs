// Drives `orcad-install.sh fetch` / `install --release` against a local stand-in for GitHub
// Releases (API listing + asset downloads), so no test ever reaches github.com.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bundleHostInstallPolicy,
  githubRepoSlugFromRemote,
  orcadReleaseAssetName,
  stampInstallerReleaseRepo
} from './pack-orcad-release.mjs'
import {
  ORCAD_INSTALLER,
  orcadInstallHostTarget,
  packFakeOrcadRelease
} from './orcad-host-install-test-fixture.mjs'

const execFileAsync = promisify(execFile)
const INSTALL_SHELL = process.env.ORCAD_INSTALL_TEST_SHELL ?? '/bin/sh'
const REPO = 'fork-owner/orca'

describe('release asset naming and installer stamping', () => {
  it('names release assets per target without the version', () => {
    expect(orcadReleaseAssetName('linux-arm64-glibc')).toBe('orcad-linux-arm64-glibc.tar.gz')
    expect(() => orcadReleaseAssetName('../x')).toThrow(/build target/)
  })

  it('derives the repository slug from https and ssh GitHub remotes only', () => {
    expect(githubRepoSlugFromRemote('https://github.com/Meapri/orca.git\n')).toBe('Meapri/orca')
    expect(githubRepoSlugFromRemote('git@github.com:Meapri/orca.git')).toBe('Meapri/orca')
    expect(githubRepoSlugFromRemote('https://github.com/stablyai/orca')).toBe('stablyai/orca')
    expect(githubRepoSlugFromRemote('https://gitlab.com/a/b.git')).toBeNull()
  })

  it('stamps the default repository into the installer, refusing a malformed slug', () => {
    const source = readFileSync(ORCAD_INSTALLER, 'utf8')
    const stamped = stampInstallerReleaseRepo(source, REPO)
    expect(stamped).toContain(`ORCAD_RELEASE_REPO_BUILT_IN='${REPO}'`)
    expect(stamped.length).toBe(source.length + REPO.length)
    expect(stampInstallerReleaseRepo(source, null)).toBe(source)
    expect(() => stampInstallerReleaseRepo(source, "a/b'; rm -rf /")).toThrow(/slug/)
  })
})

describe.skipIf(process.platform === 'win32')('orcad-install.sh release download', () => {
  let root
  let server
  let baseUrl
  let env
  const assets = new Map()
  const requests = []

  function publish(tag, tarball) {
    const asset = orcadReleaseAssetName(orcadInstallHostTarget())
    assets.set(`/${REPO}/releases/download/${tag}/${asset}`, readFileSync(tarball))
    assets.set(
      `/${REPO}/releases/download/${tag}/${asset}.sha256`,
      readFileSync(`${tarball}.sha256`)
    )
  }

  async function installer(...args) {
    try {
      const { stdout, stderr } = await execFileAsync(INSTALL_SHELL, [ORCAD_INSTALLER, ...args], {
        env,
        timeout: 60_000
      })
      return { status: 0, stdout: stdout.trim(), output: `${stdout}${stderr}` }
    } catch (error) {
      return { status: error.code, stdout: '', output: `${error.stdout}${error.stderr}` }
    }
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'oirf-'))
    await bundleHostInstallPolicy(join(root, 'policy.js'))
    const options = { policyBundle: join(root, 'policy.js'), tarballName: 'packed.tar.gz' }
    publish('orcad-v1.2.0', packFakeOrcadRelease(join(root, 'v120'), '1.2.0+aa', options))
    publish('orcad-v1.1.0', packFakeOrcadRelease(join(root, 'v110'), '1.1.0+bb', options))
    // Newest first, as the API lists them: a desktop release and an orcad prerelease lead.
    const listing = JSON.stringify(
      [
        { tag_name: 'v1.4.300' },
        { tag_name: 'orcad-v1.3.0-rc.1' },
        { tag_name: 'orcad-v1.2.0' },
        { tag_name: 'orcad-v1.1.0' }
      ],
      null,
      2
    )
    server = createServer((request, response) => {
      requests.push(request.url)
      const body =
        request.url === `/repos/${REPO}/releases?per_page=100` ? listing : assets.get(request.url)
      response.writeHead(body ? 200 : 404)
      response.end(body ?? 'not found')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
    mkdirSync(join(root, 'home'))
    env = {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      ORCAD_BASE: join(root, 'base'),
      ORCA_USER_DATA: join(root, 'data'),
      ORCAD_SERVICE: 'none',
      ORCAD_RELEASE_BASE_URL: baseUrl,
      ORCAD_RELEASE_API_URL: baseUrl
    }
  }, 120_000)

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses to guess a repository when none is stamped or given', async () => {
    const result = await installer('fetch', 'latest', '--dir', join(root, 'none'))
    expect(result.status).toBe(1)
    expect(result.output).toContain('no release repository')
  })

  it('resolves latest to the newest stable orcad tag and verifies the download', async () => {
    const dir = join(root, 'fetched')
    const result = await installer('fetch', 'latest', '--repo', REPO, '--dir', dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(join(dir, orcadReleaseAssetName(orcadInstallHostTarget())))
    expect(result.output).toContain(`release orcad-v1.2.0`)
    expect(existsSync(`${result.stdout}.sha256`)).toBe(true)
  })

  it('installs a pinned release tag and refuses a tampered asset', async () => {
    const installed = await installer('install', '--release', 'orcad-v1.1.0', '--repo', REPO)
    expect(installed.status).toBe(0)
    expect(installed.stdout).toBe('1.1.0+bb')
    expect(existsSync(join(env.ORCAD_BASE, 'orcad-1.1.0+bb', '.install-complete'))).toBe(true)

    const asset = orcadReleaseAssetName(orcadInstallHostTarget())
    const key = `/${REPO}/releases/download/orcad-v1.2.0/${asset}`
    assets.set(key, Buffer.concat([assets.get(key), Buffer.from('tampered')]))
    const refused = await installer('install', '--release', 'latest', '--repo', REPO)
    expect(refused.status).toBe(1)
    expect(refused.output).toContain('checksum mismatch')
    expect(existsSync(join(env.ORCAD_BASE, 'orcad-1.2.0+aa'))).toBe(false)
  }, 60_000)

  it('uses the repository stamped into the installer by default', async () => {
    const stamped = join(root, 'stamped-install.sh')
    writeFileSync(stamped, stampInstallerReleaseRepo(readFileSync(ORCAD_INSTALLER, 'utf8'), REPO))
    const { stdout } = await execFileAsync(
      INSTALL_SHELL,
      [stamped, 'fetch', 'orcad-v1.1.0', '--dir', join(root, 'stamped')],
      { env, timeout: 60_000 }
    )
    expect(stdout.trim()).toContain(join(root, 'stamped'))
    expect(requests).toContain(
      `/${REPO}/releases/download/orcad-v1.1.0/${orcadReleaseAssetName(orcadInstallHostTarget())}`
    )
  })
})
