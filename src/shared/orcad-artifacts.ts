/**
 * What a packaged `orcad` directory must contain, declared once — the same single-source
 * treatment `relay-artifacts.ts` gives the relay, for the same reason: the build, the
 * content hash and the remote install probe must not keep three lists that drift.
 *
 * Order is load-bearing: the hash concatenates these files in sequence.
 *
 * Keep this file erasable-only TypeScript — build-orcad.mjs imports it directly under
 * Node's type stripping, which rejects enums, namespaces and parameter properties.
 */
// Bun-era slots only: kept so a client can still launch one for rollback (design D7.1 R5).
export const ORCAD_BUN_RUNTIME_FILENAME = 'bun-runtime'
export const ORCAD_WINDOWS_BUN_RUNTIME_FILENAME = 'bun-runtime.exe'
export const ORCAD_BUILD_TARGET_FILENAME = '.build-target'
export const ORCAD_WINDOWS_PROCESS_TREE_FILENAME = 'windows-process-tree.node'

export function orcadBunRuntimeFilename(target: string): string {
  return isWindowsTarget(target) ? ORCAD_WINDOWS_BUN_RUNTIME_FILENAME : ORCAD_BUN_RUNTIME_FILENAME
}

function isWindowsTarget(target: string): boolean {
  return target === 'win32' || target.startsWith('win32-')
}

/** A Node slot's server target (e.g. linux-x64-musl); `.build-target` would mark it as Bun. */
export const ORCAD_SERVER_TARGET_FILENAME = '.server-target'

/**
 * Marks a slot launched by the pinned Node runtime; its content is that runtime's
 * executableSha256 (node-runtime-pin.ts), which is how the runtime enters the version hash.
 * A Node slot must never carry `.build-target`: Bun-era selectors exit 78 on `.build-target`
 * without `bun-runtime` (design D7.1 R5).
 */
export const ORCAD_NODE_RUNTIME_MARKER_FILENAME = '.runtime-node'
/** Beside the slot dirs and shared across Orca versions (design D2): `runtimes/node-<sha256>/bin/node`. */
export const ORCAD_RUNTIMES_DIRNAME = 'runtimes'
export const ORCAD_NODE_RUNTIME_DIR_PREFIX = 'node-'
export const ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE = 'bin/node'
// Upstream's own name and layout: renaming node.exe is the masquerading pattern EDR scores.
export const ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE = 'node.exe'

export function orcadNodeRuntimeExecutable(target: string): string {
  return isWindowsTarget(target)
    ? ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE
    : ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE
}

/** Slot-relative path segments of the runtime a slot's marker names. */
export function orcadNodeRuntimeRelativePath(target: string, executableSha256: string): string[] {
  return [
    '..',
    ORCAD_RUNTIMES_DIRNAME,
    `${ORCAD_NODE_RUNTIME_DIR_PREFIX}${executableSha256}`,
    ...orcadNodeRuntimeExecutable(target).split('/')
  ]
}

/** N-API level the slot addons are built for; equals SLOT_NAPI_VERSION in the prebuild script. */
export const ORCAD_ADDON_NAPI_VERSION = 8

export const ORCAD_NODE_PTY_DIR = 'node_modules/node-pty'
export const ORCAD_CLI_ENTRY_FILENAME = 'out/cli/index.js'
export const ORCAD_CLI_PACKAGE_FILENAME = 'out/package.json'
// Test files and sources stay out; these are every module the runtime path requires.
export const ORCAD_NODE_PTY_JS_ARTIFACTS = [
  'package.json',
  'lib/conpty_console_list_agent.js',
  'lib/eventEmitter2.js',
  'lib/index.js',
  'lib/interfaces.js',
  'lib/shared/conout.js',
  'lib/terminal.js',
  'lib/types.js',
  'lib/unixTerminal.js',
  'lib/utils.js',
  'lib/windowsConoutConnection.js',
  'lib/windowsPtyAgent.js',
  'lib/windowsTerminal.js',
  'lib/worker/conoutSocketWorker.js'
].map((file) => `${ORCAD_NODE_PTY_DIR}/${file}`)

/** The prebuild slot's files (config/scripts/orcad-prebuild-slot-contents.mjs), relative to build/Release. */
export function orcadNodePtySlotFiles(target: string): string[] {
  if (isWindowsTarget(target)) {
    return [
      'conpty.node',
      'conpty_console_list.node',
      'conpty/conpty.dll',
      'conpty/OpenConsole.exe'
    ]
  }
  return target.startsWith('darwin-') ? ['pty.node', 'spawn-helper'] : ['pty.node']
}

export function orcadNodePtyNativeArtifacts(target: string): string[] {
  return orcadNodePtySlotFiles(target).map((file) => `${ORCAD_NODE_PTY_DIR}/build/Release/${file}`)
}

export const ORCAD_PARCEL_WATCHER_ENTRY = 'node_modules/@parcel/watcher/index.js'
export const ORCAD_PARCEL_WATCHER_NATIVE = 'node_modules/@parcel/watcher/watcher.node'
export const ORCAD_EMOJI_SHORTCODE_DATASET =
  'node_modules/emojibase-data/en/shortcodes/emojibase.json'

/**
 * Release-tarball-only payloads (`pack-orcad-release.mjs`): never in ORCAD_ARTIFACTS, so SSH-managed
 * slots neither carry nor hash them. Each is optional at runtime and degrades when absent.
 */
// The browser client orcad serves; see the manifest parser below.
export const ORCAD_WEB_CLIENT_DIR = 'web'
export const ORCAD_WEB_CLIENT_MANIFEST_FILENAME = 'web/orcad-web-client.json'
export const ORCAD_WEB_CLIENT_INDEX = 'web-index.html'
export const ORCAD_WEB_CLIENT_MANIFEST_SCHEMA_VERSION = 1

export const ORCAD_VERSION = '0.1.0'
export const ORCAD_LAUNCHER_FILENAME = 'orcad.js'
export const ORCAD_SERVER_ENTRY_FILENAME = 'orcad-server.js'

// Equals FOREIGN_SQLITE_READER_ENTRY_FILENAME; that module is not loadable under type stripping.
export const ORCAD_FOREIGN_SQLITE_READER_ENTRY = 'foreign-sqlite-reader-entry.js'
/** Worker thread that runs workspace port detection's probe commands off the event loop. */
export const ORCAD_PORT_SCAN_COMMAND_WORKER_ENTRY = 'port-scan-command-worker-entry.js'
// Equals AI_VAULT_SERVICE_ENTRY_FILENAME: the forked child that lists agent sessions.
export const ORCAD_SESSION_SCANNER_SERVICE_ENTRY = 'session-scanner-service-entry.js'
// Equals USAGE_SCAN_WORKER_ENTRY_FILENAME; that module is not loadable under type stripping.
export const ORCAD_USAGE_SCAN_WORKER_ENTRY = 'usage-scan-worker-entry.js'
// Equals claude-profile-setup-worker.ts's WORKER_FILENAME; it merges a Claude account's profile off the event loop.
export const ORCAD_CLAUDE_PROFILE_SETUP_WORKER_ENTRY = 'claude-profile-setup-worker-entry.js'

/** Install-relative release-only payloads, beside the slot's ORCAD_ARTIFACTS. */
export const ORCAD_RELEASE_ONLY_PAYLOADS = [ORCAD_WEB_CLIENT_DIR] as const

// Kept here because build-orcad.mjs imports this manifest directly under Node type stripping.
export const ORCAD_RIPGREP_ARTIFACTS = [
  'ripgrep/linux-x64/rg',
  'ripgrep/linux-arm64/rg',
  'ripgrep/darwin-x64/rg',
  'ripgrep/darwin-arm64/rg',
  'ripgrep/win32-x64/rg.exe',
  'ripgrep/win32-arm64/rg.exe'
] as const

/** Only the target's own ripgrep ships (design D2); both libcs share one static build. */
export function orcadRipgrepArtifact(target: string): string {
  const [platform, arch] = target.split('-')
  const artifact = ORCAD_RIPGREP_ARTIFACTS.find((candidate) =>
    candidate.startsWith(`ripgrep/${platform}-${arch}/`)
  )
  if (!artifact) {
    throw new Error(`orcad ships no ripgrep for ${target}`)
  }
  return artifact
}

export const ORCAD_RIPGREP_LICENSE_ARTIFACTS = [
  'ripgrep/licenses/JEMALLOC-COPYING',
  'ripgrep/licenses/LICENSE-MIT',
  'ripgrep/licenses/LLVM-LIBUNWIND-LICENSE.TXT',
  'ripgrep/licenses/MUSL-COPYRIGHT',
  'ripgrep/licenses/PCRE2-LICENCE.md',
  'ripgrep/licenses/README.md',
  'ripgrep/licenses/RUST-CRATE-NOTICES.txt',
  'ripgrep/licenses/SLJIT-LICENSE',
  'ripgrep/licenses/UNLICENSE'
] as const

/** The skill plugin native-chat agents load by path; mirrors resources/native-chat-visuals. */
export const ORCAD_NATIVE_CHAT_VISUALS_ARTIFACTS = [
  'native-chat-visuals/.claude-plugin/plugin.json',
  'native-chat-visuals/skills/orca-chat-visuals/SKILL.md'
] as const

export type OrcadArtifact = {
  filename: string
  /**
   * Absence is a degradation, not a torn install, so the remote probe must not require it.
   * The agent-browser binary is the only one: `resolveOrcadBrowserProvider` already answers
   * "no headless browser" when it is missing, and it is named per platform-arch anyway.
   */
  optional?: boolean
}

export const ORCAD_ARTIFACTS: readonly OrcadArtifact[] = [
  { filename: ORCAD_CLI_ENTRY_FILENAME },
  { filename: ORCAD_CLI_PACKAGE_FILENAME },
  { filename: ORCAD_LAUNCHER_FILENAME },
  { filename: ORCAD_SERVER_ENTRY_FILENAME },
  // Forked so a native @parcel/watcher fault kills the child, not the server.
  { filename: 'parcel-watcher-process-entry.js' },
  // Forked so PTYs outlive the runtime process; its absence makes every restart destructive.
  { filename: 'daemon-entry.js' },
  { filename: 'profile-state-writer-worker-entry.js' },
  { filename: 'profile-state-backup-worker-entry.js' },
  // Worker thread that reads other apps' SQLite (the OpenCode binder and history) off the event loop.
  { filename: ORCAD_FOREIGN_SQLITE_READER_ENTRY },
  { filename: ORCAD_PORT_SCAN_COMMAND_WORKER_ENTRY },
  // Forked so transcript parsing stays off the server's event loop; session search stays in-process.
  { filename: ORCAD_SESSION_SCANNER_SERVICE_ENTRY },
  // Worker thread the usage stores scan transcripts on, for automation-run usage figures.
  { filename: ORCAD_USAGE_SCAN_WORKER_ENTRY },
  { filename: ORCAD_CLAUDE_PROFILE_SETUP_WORKER_ENTRY },
  // Target-specific even when the JavaScript bundle is shared across packaged slots.
  { filename: ORCAD_SERVER_TARGET_FILENAME },
  // orcad never depends on a host runtime or host-installed native module.
  { filename: ORCAD_NODE_RUNTIME_MARKER_FILENAME },
  { filename: ORCAD_PARCEL_WATCHER_ENTRY },
  { filename: ORCAD_PARCEL_WATCHER_NATIVE },
  { filename: ORCAD_EMOJI_SHORTCODE_DATASET },
  ...ORCAD_NODE_PTY_JS_ARTIFACTS.map((filename) => ({ filename })),
  ...ORCAD_RIPGREP_LICENSE_ARTIFACTS.map((filename) => ({ filename })),
  ...ORCAD_NATIVE_CHAT_VISUALS_ARTIFACTS.map((filename) => ({ filename }))
]

/** Written after the artifacts, so it is never an input to its own hash. */
export const ORCAD_VERSION_FILENAME = '.version'
export const ORCAD_TEMPLATE_MANIFEST_FILENAME = 'orcad-template.json'
export const ORCAD_TEMPLATE_TARGETS_DIR = 'targets'

/** Written last by the installer; its absence means a torn install. */
export const ORCAD_INSTALL_COMPLETE_FILENAME = '.install-complete'

/** Every file a `target` slot ships, in hash order; `target` is `<os>-<arch>[-<libc>]`. */
export function orcadArtifactFilenames(target: string): string[] {
  const filenames = ORCAD_ARTIFACTS.filter((artifact) => !artifact.optional).map(
    (artifact) => artifact.filename
  )
  filenames.push(...orcadNodePtyNativeArtifacts(target), orcadRipgrepArtifact(target))
  if (isWindowsTarget(target)) {
    filenames.push(ORCAD_WINDOWS_PROCESS_TREE_FILENAME)
  }
  return filenames
}

/** Files shared by every template target; the rest live under `targets/<target>/`. */
export function orcadTemplateCommonFilenames(): string[] {
  return ORCAD_ARTIFACTS.filter(
    (artifact) =>
      !artifact.optional &&
      artifact.filename !== ORCAD_SERVER_TARGET_FILENAME &&
      artifact.filename !== ORCAD_NODE_RUNTIME_MARKER_FILENAME &&
      artifact.filename !== ORCAD_PARCEL_WATCHER_NATIVE
  ).map((artifact) => artifact.filename)
}

/** Files stored under the template's `targets/<target>/`, at their slot-relative paths. */
export function orcadTemplateTargetFilenames(target: string): string[] {
  const common = new Set(orcadTemplateCommonFilenames())
  return orcadArtifactFilenames(target).filter((filename) => !common.has(filename))
}

/**
 * The browser client orcad serves from its own install directory.
 *
 * Why a manifest and not one ORCAD_ARTIFACTS entry per file: the Vite bundle is ~1000
 * content-hashed files whose names change every build. The manifest is the one fixed artifact;
 * it pins every file's size and SHA-256, so hashing it into the install identity commits to the
 * whole bundle.
 */

export type OrcadWebClientFile = {
  /** POSIX path relative to the web client directory. */
  path: string
  size: number
  sha256: string
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const SEGMENT_PATTERN = /^[A-Za-z0-9_@+~][A-Za-z0-9._@+~-]*$/u

/** Why strict: each path is joined onto an install directory and copied or served from there. */
export function isSafeOrcadWebClientPath(path: string): boolean {
  if (path.length === 0 || path.length > 512) {
    return false
  }
  return path.split('/').every((segment) => SEGMENT_PATTERN.test(segment) && segment !== '..')
}

export function parseOrcadWebClientManifest(text: string): OrcadWebClientFile[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('orcad web client manifest is not valid JSON')
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== ORCAD_WEB_CLIENT_MANIFEST_SCHEMA_VERSION) {
    throw new Error('orcad web client manifest has an unsupported schemaVersion')
  }
  if (!Array.isArray(parsed.files)) {
    throw new Error('orcad web client manifest has no file list')
  }
  const seen = new Set<string>()
  const files: OrcadWebClientFile[] = []
  for (const entry of parsed.files) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      !isSafeOrcadWebClientPath(entry.path) ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== 'string' ||
      !SHA256_PATTERN.test(entry.sha256) ||
      seen.has(entry.path)
    ) {
      throw new Error('orcad web client manifest has an invalid file entry')
    }
    seen.add(entry.path)
    files.push({ path: entry.path, size: entry.size, sha256: entry.sha256 })
  }
  if (!seen.has(ORCAD_WEB_CLIENT_INDEX)) {
    throw new Error(`orcad web client manifest does not list ${ORCAD_WEB_CLIENT_INDEX}`)
  }
  return files
}

export function serializeOrcadWebClientManifest(files: readonly OrcadWebClientFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return `${JSON.stringify({ schemaVersion: ORCAD_WEB_CLIENT_MANIFEST_SCHEMA_VERSION, files: sorted }, null, 2)}\n`
}

/** Install-relative names of the manifest's files, e.g. `web/assets/index-abc.js`. */
export function orcadWebClientArtifactFilename(file: Pick<OrcadWebClientFile, 'path'>): string {
  return `${ORCAD_WEB_CLIENT_DIR}/${file.path}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
