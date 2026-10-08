// Packages an ad-hoc signed, unnotarized macOS build (no Apple Developer ID) for this
// distribution. Run after `pnpm build:release`. Usage:
//   node config/scripts/package-mac-adhoc.mjs [--arch arm64|x64] [--version X.Y.Z]
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const RELEASE_SIGNING_ENV = [
  'ORCA_MAC_RELEASE',
  'ORCA_MAC_HOURLY',
  'ORCA_MAC_DAILY',
  'ORCA_MAC_ADHOC'
]
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function parsePackageMacAdhocArgs(argv, defaults) {
  const options = { arch: defaults.arch, version: defaults.version }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--arch' || flag === '--version') {
      if (!value) {
        throw new Error(`${flag} needs a value`)
      }
      options[flag.slice(2)] = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${flag}`)
  }
  if (options.arch !== 'arm64' && options.arch !== 'x64') {
    throw new Error(`Unsupported arch ${options.arch}; expected arm64 or x64`)
  }
  if (!SEMVER.test(options.version)) {
    throw new Error(`Version is not valid semver: ${options.version}`)
  }
  return options
}

/** Env that forces every signature in the bundle to ad-hoc, whatever the keychain holds. */
export function createAdhocSigningEnv(baseEnv, { version, commit, arch }) {
  for (const key of RELEASE_SIGNING_ENV) {
    if (baseEnv[key] === '1') {
      throw new Error(`${key}=1 selects Developer ID signing; unset it for an ad-hoc build`)
    }
  }
  return {
    ...baseEnv,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    // Why '-': the nested helpers read CSC_NAME, electron-builder reads -c.mac.identity.
    CSC_NAME: '-',
    ORCA_COMPUTER_MACOS_SIGN_IDENTITY: '-',
    ORCA_LOCAL_BUILD_VERSION: version,
    ORCA_BUILD_COMMIT: commit,
    ORCA_MAC_ARCHS: arch
  }
}

function main() {
  const repoRoot = resolve(import.meta.dirname, '..', '..')
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const distribution = JSON.parse(
    readFileSync(join(repoRoot, 'src', 'shared', 'app-distribution.json'), 'utf8')
  )
  const options = parsePackageMacAdhocArgs(process.argv.slice(2), {
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    version: packageJson.version
  })
  const commit =
    process.env.GITHUB_SHA?.slice(0, 12) ||
    execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8'
    }).trim()
  console.log(
    `[package:mac:adhoc] ${distribution.productName} ${options.version} (${options.arch})`
  )
  execFileSync(
    'pnpm',
    [
      'exec',
      'electron-builder',
      '--config',
      'config/electron-builder.config.cjs',
      '--mac',
      `--${options.arch}`,
      '--publish',
      'never',
      '-c.mac.identity=-'
    ],
    {
      cwd: repoRoot,
      env: createAdhocSigningEnv(process.env, {
        version: options.version,
        commit,
        arch: options.arch
      }),
      stdio: 'inherit'
    }
  )
  const appDir = join(repoRoot, 'dist', options.arch === 'arm64' ? 'mac-arm64' : 'mac')
  const appPath = join(appDir, `${distribution.productName}.app`)
  if (!existsSync(appPath)) {
    throw new Error(`Packaged app missing at ${appPath}`)
  }
  // Why: the in-app updater refuses bundles whose seal does not verify, so fail here first.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  const artifacts = readdirSync(join(repoRoot, 'dist')).filter((name) =>
    name.startsWith(`${distribution.artifactBaseName}-macos-${options.arch}`)
  )
  console.log(`[package:mac:adhoc] app: ${appPath}`)
  for (const name of artifacts) {
    console.log(`[package:mac:adhoc] artifact: ${join(repoRoot, 'dist', name)}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main()
}
