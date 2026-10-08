import { describe, expect, it } from 'vitest'
import {
  commandLineUsesChromiumProfile,
  reapExternalChromiumProfileProcesses
} from './external-chromium-orphan-reaper'

const PROFILE = '/srv/orca data/browser-chromium'

function row(pid: number, commandLine: string) {
  return { pid, ppid: 1, startedAtMs: 0, executable: '', argv: commandLine.split(' ') }
}

describe('commandLineUsesChromiumProfile', () => {
  it('matches the exact profile, including a path with spaces, and not a sibling prefix', () => {
    expect(
      commandLineUsesChromiumProfile(`/opt/chrome --user-data-dir=${PROFILE} --headless`, PROFILE)
    ).toBe(true)
    expect(commandLineUsesChromiumProfile(`/opt/chrome --user-data-dir=${PROFILE}`, PROFILE)).toBe(
      true
    )
    expect(
      commandLineUsesChromiumProfile(`/opt/chrome --user-data-dir=${PROFILE}-2 --x`, PROFILE)
    ).toBe(false)
    expect(commandLineUsesChromiumProfile('/opt/chrome --user-data-dir=/other', PROFILE)).toBe(
      false
    )
  })
})

describe('reapExternalChromiumProfileProcesses', () => {
  it('terminates the orphaned tree on this profile and kills what outlives the grace', async () => {
    const alive = new Set([10, 11, 12, 20])
    const signals: string[] = []
    const outcome = await reapExternalChromiumProfileProcesses(PROFILE, {
      sweep: async () => [
        row(10, `/opt/chrome --user-data-dir=${PROFILE} --remote-debugging-port=0`),
        row(11, `/opt/chrome --type=renderer --user-data-dir=${PROFILE}`),
        row(12, `/opt/chrome --type=gpu-process --user-data-dir=${PROFILE}`),
        row(20, '/opt/chrome --user-data-dir=/home/user/.config/chromium'),
        row(process.pid, `node orcad.js --user-data-dir=${PROFILE}`)
      ],
      signal: (pid, name) => {
        signals.push(`${name}:${pid}`)
        // The browser main and its renderer honour SIGTERM; the GPU process is wedged.
        if (name === 'SIGKILL' || pid !== 12) {
          alive.delete(pid)
        }
      },
      isAlive: (pid) => alive.has(pid),
      sleep: async () => {},
      graceMs: 300
    })
    expect(outcome).toEqual({ signalled: [10, 11, 12], killed: [12] })
    expect(signals).toEqual(['SIGTERM:10', 'SIGTERM:11', 'SIGTERM:12', 'SIGKILL:12'])
    // The user's own browser on another profile is untouched.
    expect(alive.has(20)).toBe(true)
  })

  it('does nothing when no process runs on the profile', async () => {
    const outcome = await reapExternalChromiumProfileProcesses(PROFILE, {
      sweep: async () => [row(30, '/usr/bin/bash')],
      signal: () => {
        throw new Error('must not signal')
      },
      isAlive: () => false,
      sleep: async () => {}
    })
    expect(outcome).toEqual({ signalled: [], killed: [] })
  })
})
