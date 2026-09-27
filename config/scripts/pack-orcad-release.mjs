#!/usr/bin/env node
/**
 * Package one orcad target as a standalone release asset for self-managed Linux hosts.
 *
 * The tarball holds exactly the versioned install directory the SSH deploy creates
 * (`orcad-<fullVersion>/`, same artifacts, same `.version`), plus the on-host installer kit.
 * `config/orcad-host/orcad-install.sh` verifies the checksum before it extracts anything.
 *
 *   node config/scripts/pack-orcad-release.mjs [--target linux-x64-glibc] [--from out/orcad]
 *     [--asset-names stable] [--release-repo OWNER/NAME]
 *
 * `--asset-names stable` names the tarball `orcad-<target>.tar.gz`, the name a GitHub Release
 * carries and `orcad-install.sh --release` downloads; the installer reads the version from
 * the tarball's top directory, never from its filename. The installer copies are stamped
 * with the release repository (flag, else ORCAD_RELEASE_REPO / GITHUB_REPOSITORY, else the
 * `origin` remote) so `--release latest` needs no `--repo`.
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { build } from 'esbuild'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME,
  orcadArtifactFilenames
} from '../../src/shared/orcad-artifacts.ts'
import { runProcessSync } from './script-child-process.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
export const ORCAD_HOST_KIT_DIR = join(ROOT, 'config', 'orcad-host')
/** Kit files copied into `<install dir>/deploy/`; the installer renders units from here. */
export const ORCAD_HOST_KIT_FILES = ['orcad-install.sh', 'orcad.service', 'orcad-system.service']
export const ORCAD_HOST_INSTALL_BUNDLE = 'orcad-host-install.js'
const HOST_INSTALL_ENTRY = join(ROOT, 'src/main/orcad/host-install/host-install-entry.ts')

export function orcadInstallDirName(fullVersion) {
  return `orcad-${fullVersion}`
}

export function orcadReleaseTarballName(fullVersion, target) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+\+[0-9a-f]+$/.test(fullVersion)) {
    throw new Error(`Not a content-hashed orcad version: ${JSON.stringify(fullVersion)}`)
  }
  if (!/^[a-z0-9]+-[a-z0-9]+(-(glibc|musl))?$/.test(target)) {
    throw new Error(`Not an orcad build target: ${JSON.stringify(target)}`)
  }
  return `orcad-${fullVersion}-${target}.tar.gz`
}

/** The release-asset name: fixed per target, and free of the `+` GitHub may rewrite. */
export function orcadReleaseAssetName(target) {
  if (!/^[a-z0-9]+-[a-z0-9]+(-(glibc|musl))?$/.test(target)) {
    throw new Error(`Not an orcad build target: ${JSON.stringify(target)}`)
  }
  return `orcad-${target}.tar.gz`
}

/** `owner/name` from a GitHub remote URL (https or ssh), or null for anything else. */
export function githubRepoSlugFromRemote(remoteUrl) {
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    remoteUrl.trim()
  )
  return match ? `${match[1]}/${match[2]}` : null
}

const INSTALLER_REPO_LINE = /^ORCAD_RELEASE_REPO_BUILT_IN=''$/m

/** Bakes the default release repository into an installer copy. */
export function stampInstallerReleaseRepo(installerSource, slug) {
  if (!slug) {
    return installerSource
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new Error(`Not a GitHub repository slug: ${JSON.stringify(slug)}`)
  }
  if (!INSTALLER_REPO_LINE.test(installerSource)) {
    throw new Error('orcad-install.sh has no ORCAD_RELEASE_REPO_BUILT_IN line to stamp')
  }
  return installerSource.replace(INSTALLER_REPO_LINE, `ORCAD_RELEASE_REPO_BUILT_IN='${slug}'`)
}

/** `sha256sum -c` format, so operators can verify with standard tools too. */
export function sha256Line(hex, filename) {
  return `${hex}  ${filename}\n`
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Refuse to package a directory the installer's own verification would reject. */
export function assertReleasableBundle(dir, expectedTarget) {
  const version = readFileSync(join(dir, ORCAD_VERSION_FILENAME), 'utf8').trim()
  const target = readFileSync(join(dir, ORCAD_BUILD_TARGET_FILENAME), 'utf8').trim()
  if (expectedTarget && target !== expectedTarget) {
    throw new Error(`${dir} was built for ${target}, not ${expectedTarget}`)
  }
  if (target.startsWith('win32-')) {
    throw new Error('The on-host installer is POSIX-only; Windows uses standalone builds')
  }
  const missing = orcadArtifactFilenames(target).filter((name) => !existsSync(join(dir, name)))
  if (missing.length > 0) {
    throw new Error(`${dir} is missing declared orcad artifacts: ${missing.join(', ')}`)
  }
  return { version, target }
}

export async function bundleHostInstallPolicy(outfile) {
  await build({
    stdin: {
      contents:
        `const { runHostInstallVerb } = require(${JSON.stringify(HOST_INSTALL_ENTRY)});\n` +
        'const outcome = runHostInstallVerb(process.argv.slice(2));\n' +
        "process.stdout.write(JSON.stringify(outcome.output) + '\\n');\n" +
        'process.exitCode = outcome.exitCode;\n',
      resolveDir: ROOT,
      sourcefile: 'orcad-host-install-main.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile,
    // Nothing here may reach a native module or Electron; fail the build if it does.
    external: [],
    minify: true,
    logLevel: 'error'
  })
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

function resolveReleaseRepoSlug() {
  const explicit =
    argument('--release-repo') ?? process.env.ORCAD_RELEASE_REPO ?? process.env.GITHUB_REPOSITORY
  if (explicit) {
    return explicit
  }
  const remote = runProcessSync({
    program: 'git',
    args: ['remote', 'get-url', 'origin'],
    cwd: ROOT
  })
  return remote.code === 0 ? githubRepoSlugFromRemote(remote.stdout) : null
}

function run(program, args, options = {}) {
  const result = runProcessSync({ program, args, cwd: ROOT, timeoutMs: null, ...options })
  if (result.code !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result
}

async function main() {
  const outDir = resolve(argument('--out-dir') ?? join(ROOT, 'out', 'orcad-release'))
  const assetNames = argument('--asset-names') ?? 'versioned'
  if (assetNames !== 'versioned' && assetNames !== 'stable') {
    throw new Error(`--asset-names expects versioned|stable, got ${JSON.stringify(assetNames)}`)
  }
  const releaseRepo = resolveReleaseRepoSlug()
  const installerSource = stampInstallerReleaseRepo(
    readFileSync(join(ORCAD_HOST_KIT_DIR, 'orcad-install.sh'), 'utf8'),
    releaseRepo
  )
  let target = argument('--target')
  let source = argument('--from')
  if (!source) {
    const { currentTarget } = await import('./build-orcad-bun.mjs')
    target ??= currentTarget()
    source = join(ROOT, 'out', '.orcad-release-build', target)
    run(process.execPath, [
      join(ROOT, 'config/scripts/build-orcad-bun.mjs'),
      '--target',
      target,
      '--out-dir',
      source
    ])
  }
  source = resolve(source)
  const { version, target: builtTarget } = assertReleasableBundle(source, target)
  const stageRoot = join(ROOT, 'out', '.orcad-release-stage', builtTarget)
  const stage = join(stageRoot, orcadInstallDirName(version))
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(dirname(stage), { recursive: true })
  cpSync(source, stage, { recursive: true, verbatimSymlinks: true })
  await bundleHostInstallPolicy(join(stage, ORCAD_HOST_INSTALL_BUNDLE))
  mkdirSync(join(stage, 'deploy'), { recursive: true })
  for (const file of ORCAD_HOST_KIT_FILES) {
    copyFileSync(join(ORCAD_HOST_KIT_DIR, file), join(stage, 'deploy', file))
  }
  writeFileSync(join(stage, 'deploy', 'orcad-install.sh'), installerSource)
  chmodSync(join(stage, 'deploy', 'orcad-install.sh'), 0o755)

  mkdirSync(outDir, { recursive: true })
  const tarball =
    assetNames === 'stable'
      ? orcadReleaseAssetName(builtTarget)
      : orcadReleaseTarballName(version, builtTarget)
  // COPYFILE_DISABLE keeps macOS bsdtar from adding AppleDouble `._*` members.
  run('tar', ['-C', stageRoot, '-czf', join(outDir, tarball), basename(stage)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  })
  const tarballSha = sha256File(join(outDir, tarball))
  writeFileSync(join(outDir, `${tarball}.sha256`), sha256Line(tarballSha, tarball))
  writeFileSync(join(outDir, 'orcad-install.sh'), installerSource, { mode: 0o755 })
  const installerSha = sha256File(join(outDir, 'orcad-install.sh'))
  writeFileSync(
    join(outDir, 'orcad-install.sh.sha256'),
    sha256Line(installerSha, 'orcad-install.sh')
  )
  const manifest = {
    schemaVersion: 1,
    fullVersion: version,
    target: builtTarget,
    tarball,
    sha256: tarballSha,
    installerSha256: installerSha,
    ...(releaseRepo ? { releaseRepo } : {})
  }
  writeFileSync(
    join(
      outDir,
      assetNames === 'stable' ? `orcad-${builtTarget}.json` : `orcad-${version}-${builtTarget}.json`
    ),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  rmSync(stageRoot, { recursive: true, force: true })
  process.stdout.write(`[pack-orcad-release] ${join(outDir, tarball)} sha256=${tarballSha}\n`)
}

if (process.argv[1]?.endsWith('pack-orcad-release.mjs')) {
  await main()
}
