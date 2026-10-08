/**
 * `orcad-host-install.js`: the policy half of `orcad-install.sh`, run by the pinned Node an
 * installed orcad references (`../runtimes/node-<sha256>/bin/node`). The shell script owns files and the service manager; every decision about
 * live work, activation health, snapshots and rollback is made here, by the SSH deploy's own
 * functions. One JSON line on stdout per verb; the exit code carries the decision.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME,
  orcadArtifactFilenames,
  orcadNodeRuntimeRelativePath
} from '../../../shared/orcad-artifacts'
import { withActivatedVersion, withRolledBackVersion } from '../../ssh/orcad-activation-record'
import { remoteInstallDirName, ORCAD_INSTALL_MODEL } from '../../ssh/remote-install-model'
import { evaluateTerminalCensus, inspectDaemonIsolation } from './host-install-census'
import {
  assessServiceStop,
  gateHostActivation,
  planHostActivation
} from './host-install-activation'
import {
  captureHostSnapshot,
  clearPendingActivation,
  readActivationRecord,
  readPendingActivation,
  restoreHostSnapshot,
  stateUnchangedSinceSnapshot,
  writeActivationRecord
} from './host-install-state'
import { planHostRollback, pruneHostInstall } from './host-install-rollback'
import {
  CURRENT_ORCAD_DAEMON_PROTOCOL,
  type OrcadDaemonProtocolFacts
} from '../../ssh/orcad-daemon-protocol-crossing'

const HOST_INSTALL_EXIT = { ok: 0, usage: 2, noop: 10, refused: 20, rejected: 30 } as const

export type HostInstallOutcome = { exitCode: number; output: Record<string, unknown> }

type Flags = Map<string, string>

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`)
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(arg.slice(2), '1')
    } else {
      flags.set(arg.slice(2), next)
      index += 1
    }
  }
  return flags
}

function required(flags: Flags, name: string): string {
  const value = flags.get(name)
  if (!value) {
    throw new Error(`--${name} is required`)
  }
  return value
}

function readOptionalFile(path: string | undefined): string | null {
  return path && existsSync(path) ? readFileSync(path, 'utf8') : null
}

function liveWork(flags: Flags) {
  return {
    isolation: inspectDaemonIsolation({ dataRoot: required(flags, 'data-root') }),
    census: evaluateTerminalCensus(readOptionalFile(flags.get('census-file')))
  }
}

/** `--target-protocol` is the target bundle's own `daemon-protocol` line; absent or bad = unknown. */
function parseTargetProtocol(raw: string | undefined): OrcadDaemonProtocolFacts | null {
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'protocolVersion' in parsed &&
      Number.isSafeInteger(parsed.protocolVersion) &&
      'previousProtocolVersions' in parsed &&
      Array.isArray(parsed.previousProtocolVersions) &&
      parsed.previousProtocolVersions.every((version: unknown) => Number.isSafeInteger(version))
    ) {
      return {
        protocolVersion: Number(parsed.protocolVersion),
        previousProtocolVersions: parsed.previousProtocolVersions.map(Number)
      }
    }
  } catch {
    // Fall through: unknown facts plan as unattachable.
  }
  return null
}

function decided(ok: boolean, output: Record<string, unknown>): HostInstallOutcome {
  return { exitCode: ok ? HOST_INSTALL_EXIT.ok : HOST_INSTALL_EXIT.refused, output }
}

function verifyBundle(dir: string): HostInstallOutcome {
  const version = readFileSync(join(dir, ORCAD_VERSION_FILENAME), 'utf8').trim()
  const target = readFileSync(join(dir, ORCAD_SERVER_TARGET_FILENAME), 'utf8').trim()
  const missing = orcadArtifactFilenames(target).filter((name) => !existsSync(join(dir, name)))
  const expectedName = remoteInstallDirName(ORCAD_INSTALL_MODEL, version)
  const problems = [
    ...missing.map((name) => `missing ${name}`),
    ...verifyReferencedRuntime(dir, target),
    ...(basename(dir) === expectedName ? [] : [`directory is not named ${expectedName}`])
  ]
  return decided(problems.length === 0, { version, target, problems })
}

/** The slot names its pinned Node by digest; the bytes beside it must hash to that name. */
function verifyReferencedRuntime(dir: string, target: string): string[] {
  const markerPath = join(dir, ORCAD_NODE_RUNTIME_MARKER_FILENAME)
  const sha256 = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : ''
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return [`${ORCAD_NODE_RUNTIME_MARKER_FILENAME} does not name a runtime digest`]
  }
  const runtimePath = join(dir, ...orcadNodeRuntimeRelativePath(target, sha256))
  if (!existsSync(runtimePath)) {
    return [`missing the referenced runtime ${runtimePath}`]
  }
  const actual = createHash('sha256').update(readFileSync(runtimePath)).digest('hex')
  return actual === sha256 ? [] : [`runtime ${runtimePath} does not hash to ${sha256}`]
}

const VERBS: Record<string, (flags: Flags, now: Date) => HostInstallOutcome> = {
  'verify-bundle': (flags) => verifyBundle(required(flags, 'dir')),
  'daemon-isolation': (flags) => ({
    exitCode: HOST_INSTALL_EXIT.ok,
    output: { ...inspectDaemonIsolation({ dataRoot: required(flags, 'data-root') }) }
  }),
  'daemon-protocol': () => ({
    exitCode: HOST_INSTALL_EXIT.ok,
    output: { ...CURRENT_ORCAD_DAEMON_PROTOCOL }
  }),
  record: (flags) => ({
    exitCode: HOST_INSTALL_EXIT.ok,
    output: { ...readActivationRecord(required(flags, 'base')) }
  }),
  'preflight-stop': (flags) => {
    const { isolation, census } = liveWork(flags)
    // Decommissioning retires the daemon too, so scope isolation alone is not enough.
    const retiring = flags.has('retire-daemon')
    if (!retiring) {
      return decided(assessServiceStop(isolation, census).safe, {
        ...assessServiceStop(isolation, census),
        isolation,
        census
      })
    }
    const idle = isolation.state === 'no-daemon' || census.verdict === 'empty'
    return decided(idle, {
      reason: idle
        ? 'No live terminals; the daemon may be retired.'
        : `Retiring the daemon would end live work (census: ${census.verdict}).`,
      isolation,
      census
    })
  },
  'preflight-activate': (flags) => {
    const { isolation, census } = liveWork(flags)
    const plan = planHostActivation({
      record: readActivationRecord(required(flags, 'base')),
      candidateVersion: required(flags, 'candidate'),
      isolation,
      census,
      force: flags.has('force'),
      serviceStopped: flags.get('service-running') === '0'
    })
    const exitCode =
      plan.action === 'proceed'
        ? HOST_INSTALL_EXIT.ok
        : plan.action === 'noop'
          ? HOST_INSTALL_EXIT.noop
          : HOST_INSTALL_EXIT.refused
    return { exitCode, output: { ...plan, isolation, census } }
  },
  'capture-snapshot': (flags, now) => {
    const base = required(flags, 'base')
    const pending = captureHostSnapshot({
      base,
      dataRoot: required(flags, 'data-root'),
      candidate: required(flags, 'candidate'),
      outgoing: readActivationRecord(base).active,
      now
    })
    return { exitCode: HOST_INSTALL_EXIT.ok, output: { ...pending } }
  },
  gate: (flags) => {
    const candidate = required(flags, 'candidate')
    const verdict = gateHostActivation({
      readinessRaw: readOptionalFile(required(flags, 'readiness')) ?? '',
      versionDir: join(
        required(flags, 'base'),
        remoteInstallDirName(ORCAD_INSTALL_MODEL, candidate)
      ),
      fullVersion: candidate,
      mainPid: Number(flags.get('main-pid') ?? '') || null
    })
    return {
      exitCode: verdict.decision === 'activate' ? HOST_INSTALL_EXIT.ok : HOST_INSTALL_EXIT.rejected,
      output: { ...verdict }
    }
  },
  'commit-activation': (flags, now) => {
    const base = required(flags, 'base')
    const candidate = required(flags, 'candidate')
    const pending = readPendingActivation(base)
    const record = withActivatedVersion(
      readActivationRecord(base),
      candidate,
      pending?.candidate === candidate ? pending.snapshot : null,
      now
    )
    writeActivationRecord(base, record)
    clearPendingActivation(base)
    return { exitCode: HOST_INSTALL_EXIT.ok, output: { ...record } }
  },
  'abort-activation': (flags) => {
    const base = required(flags, 'base')
    const pending = readPendingActivation(base)
    const unchanged = stateUnchangedSinceSnapshot({
      base,
      dataRoot: required(flags, 'data-root'),
      snapshot: pending?.snapshot ?? null
    })
    if (unchanged) {
      clearPendingActivation(base)
    }
    return decided(unchanged, {
      incumbent: readActivationRecord(base).active,
      reason: unchanged
        ? 'The rejected candidate left profile state unchanged; the incumbent may restart.'
        : 'Profile state changed or could not be verified, so the incumbent was not ' +
          'restarted against it. The pre-activation snapshot is retained for recovery.',
      snapshot: pending?.snapshot ?? null
    })
  },
  'preflight-rollback': (flags) => {
    const base = required(flags, 'base')
    const { isolation, census } = liveWork(flags)
    const stop = assessServiceStop(isolation, census)
    if (!stop.safe) {
      return decided(false, { ...stop, isolation, census })
    }
    const safety = planHostRollback({
      base,
      dataRoot: required(flags, 'data-root'),
      record: readActivationRecord(base),
      isolation,
      census,
      targetDaemonProtocol: parseTargetProtocol(flags.get('target-protocol'))
    })
    return decided(safety.safety !== 'unsafe', { ...safety, isolation, census })
  },
  'restore-snapshot': (flags) => {
    const base = required(flags, 'base')
    const snapshot = readActivationRecord(base).snapshot
    const restored = snapshot
      ? restoreHostSnapshot({ base, dataRoot: required(flags, 'data-root'), snapshot })
      : 'missing'
    return decided(restored === 'restored', { restored })
  },
  'commit-rollback': (flags, now) => {
    const base = required(flags, 'base')
    const record = withRolledBackVersion(readActivationRecord(base), now)
    writeActivationRecord(base, record)
    return { exitCode: HOST_INSTALL_EXIT.ok, output: { ...record } }
  },
  prune: (flags) => {
    const base = required(flags, 'base')
    const result = pruneHostInstall({
      base,
      record: readActivationRecord(base),
      isolation: inspectDaemonIsolation({ dataRoot: required(flags, 'data-root') }),
      pendingCandidate: readPendingActivation(base)?.candidate ?? null,
      dryRun: flags.has('dry-run')
    })
    return { exitCode: HOST_INSTALL_EXIT.ok, output: { ...result } }
  }
}

export function runHostInstallVerb(argv: readonly string[], now = new Date()): HostInstallOutcome {
  const [verb, ...rest] = argv
  const run = verb ? VERBS[verb] : undefined
  if (!run) {
    return {
      exitCode: HOST_INSTALL_EXIT.usage,
      output: { error: `Unknown verb ${verb ?? '(none)'}`, verbs: Object.keys(VERBS) }
    }
  }
  try {
    return run(parseFlags(rest), now)
  } catch (error) {
    return {
      exitCode: 1,
      output: { error: error instanceof Error ? error.message : String(error) }
    }
  }
}
