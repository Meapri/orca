/** Doctor checks about the host itself: systemd user manager, linger, glibc floor, disk. */
import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import {
  describeDurableDaemonScopeSupport,
  type DurableDaemonScopeSupport
} from '../daemon/daemon-cgroup-scope'
import {
  detectNativeHostAbi,
  GLIBC_FLOOR,
  isBelowGlibcFloor,
  type NativeHostAbi
} from './native-host-abi'
import type { OrcadDoctorCheck } from './orcad-doctor-report'

const SYSTEMD_BOOT_PATH = '/run/systemd/system'
const LINGER_DIR = '/var/lib/systemd/linger'
const DISK_FAIL_BYTES = 512 * 1024 * 1024
const DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024

function accountName(): string {
  try {
    return userInfo().username
  } catch {
    return '$USER'
  }
}

export function checkDaemonScopeSupport(
  platform: NodeJS.Platform,
  support: () => DurableDaemonScopeSupport = () =>
    describeDurableDaemonScopeSupport(process.env, platform)
): OrcadDoctorCheck {
  const id = 'systemd-user-scope'
  const verdict = support()
  switch (verdict) {
    case 'not_linux':
      return { id, status: 'skip', summary: 'Daemon scope isolation is a Linux systemd feature.' }
    case 'no_systemd':
      return {
        id,
        status: 'skip',
        summary:
          'systemd is not PID 1 here (a container?), so a unit restart cannot reap terminals.'
      }
    case 'no_user_bus':
      return {
        id,
        status: 'warn',
        summary:
          "No reachable systemd user bus, so the terminal daemon falls back into orcad's service cgroup and a unit restart kills live terminals.",
        fix: `sudo loginctl enable-linger ${accountName()}  # then: systemctl --user status`
      }
    case 'systemd_run_unavailable':
      return {
        id,
        status: 'warn',
        summary: '`systemd-run --version` did not answer, so the daemon cannot get its own scope.',
        fix: 'See the failure: systemd-run --user --scope true'
      }
    case 'supported':
      return {
        id,
        status: 'pass',
        summary: 'The systemd user manager is reachable; the daemon gets its own scope.'
      }
  }
}

export function checkUserLinger(
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
  account: string = accountName()
): OrcadDoctorCheck {
  const id = 'systemd-linger'
  if (platform !== 'linux' || !exists(SYSTEMD_BOOT_PATH)) {
    return { id, status: 'skip', summary: 'Linger applies to Linux systemd hosts only.' }
  }
  return exists(join(LINGER_DIR, account))
    ? {
        id,
        status: 'pass',
        summary: `Linger is enabled for ${account}; its user manager outlives SSH logins.`
      }
    : {
        id,
        status: 'warn',
        summary: `Linger is off for ${account}: its user manager, and the daemon scope in it, stop when the last login session ends.`,
        fix: `sudo loginctl enable-linger ${account}`
      }
}

export function checkGlibcFloor(
  platform: NodeJS.Platform,
  abi: Pick<NativeHostAbi, 'libc' | 'glibcVersion'> = detectNativeHostAbi()
): OrcadDoctorCheck {
  const id = 'glibc'
  if (platform !== 'linux') {
    return { id, status: 'skip', summary: 'The glibc floor applies to Linux only.' }
  }
  if (abi.libc === 'musl') {
    return { id, status: 'pass', summary: 'musl host: orcad loads the linux-*-musl prebuilds.' }
  }
  const below = isBelowGlibcFloor(abi.glibcVersion)
  if (below === null) {
    return {
      id,
      status: 'warn',
      summary: 'Could not read the glibc version.',
      fix: 'Check it: ldd --version'
    }
  }
  return below
    ? {
        id,
        status: 'fail',
        summary: `glibc ${abi.glibcVersion} is below the supported floor ${GLIBC_FLOOR}; native modules will not load.`,
        fix: 'Use Ubuntu 20.04+ / Debian 11+, or a musl (Alpine) host.'
      }
    : {
        id,
        status: 'pass',
        summary: `glibc ${abi.glibcVersion} meets the ${GLIBC_FLOOR} floor.`
      }
}

function nearestExistingPath(path: string, exists: (candidate: string) => boolean): string {
  let current = path
  while (!exists(current) && dirname(current) !== current) {
    current = dirname(current)
  }
  return current
}

export async function checkDiskSpace(
  dataRoot: string,
  readFreeBytes: (path: string) => Promise<number> = async (path) => {
    const stats = await statfs(path)
    return stats.bavail * stats.bsize
  },
  exists: (path: string) => boolean = existsSync
): Promise<OrcadDoctorCheck> {
  const id = 'disk-space'
  const target = nearestExistingPath(dataRoot, exists)
  let free: number
  try {
    free = await readFreeBytes(target)
  } catch (error) {
    return {
      id,
      status: 'warn',
      summary: `Could not read free space on ${target}: ${String(error)}`
    }
  }
  const gib = (free / 1024 ** 3).toFixed(1)
  if (free < DISK_FAIL_BYTES) {
    return {
      id,
      status: 'fail',
      summary: `Only ${gib} GiB free on ${target}; persistence and logs will fail.`,
      fix: 'Free space, or move ORCA_USER_DATA to a larger volume.'
    }
  }
  return free < DISK_WARN_BYTES
    ? {
        id,
        status: 'warn',
        summary: `${gib} GiB free on ${target}; logs and history will fill it.`
      }
    : { id, status: 'pass', summary: `${gib} GiB free on ${target}.` }
}
