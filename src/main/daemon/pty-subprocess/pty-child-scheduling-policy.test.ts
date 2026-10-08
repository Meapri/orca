import { describe, expect, it, vi } from 'vitest'
import { applyPtyChildSchedulingPolicy } from './pty-child-scheduling-policy'

function deps(options: {
  ownNice?: number
  childNice?: number
  oomScoreAdj?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  setPriorityThrows?: boolean
}) {
  const setPriority = vi.fn((_pid: number, _priority: number) => {
    if (options.setPriorityThrows) {
      throw new Error('EACCES')
    }
  })
  const writeFile = vi.fn()
  return {
    setPriority,
    writeFile,
    deps: {
      platform: options.platform ?? 'linux',
      env: options.env ?? {},
      getPriority: (pid?: number) =>
        pid === undefined ? (options.ownNice ?? 0) : (options.childNice ?? options.ownNice ?? 0),
      setPriority,
      readFile: () => `${options.oomScoreAdj ?? '0'}\n`,
      writeFile
    }
  }
}

describe('applyPtyChildSchedulingPolicy nice reset', () => {
  it('resets a child that inherited a niced daemon to 0', () => {
    const fake = deps({ ownNice: 10 })
    expect(applyPtyChildSchedulingPolicy(42, fake.deps).nice).toBe('set')
    expect(fake.setPriority).toHaveBeenCalledWith(42, 0)
  })

  it('leaves children of an un-niced daemon alone', () => {
    const fake = deps({ ownNice: 0 })
    expect(applyPtyChildSchedulingPolicy(42, fake.deps).nice).toBe('unchanged')
    expect(fake.setPriority).not.toHaveBeenCalled()
  })

  it('keeps inheritance when the operator asks for it', () => {
    const fake = deps({ ownNice: 10, env: { ORCA_TERMINAL_NICE: 'inherit' } })
    applyPtyChildSchedulingPolicy(42, fake.deps)
    expect(fake.setPriority).not.toHaveBeenCalled()
  })

  it('pins an explicit level', () => {
    const fake = deps({ ownNice: 0, env: { ORCA_TERMINAL_NICE: '5' } })
    applyPtyChildSchedulingPolicy(42, fake.deps)
    expect(fake.setPriority).toHaveBeenCalledWith(42, 5)
  })

  it('reports a denied reset without throwing (no RLIMIT_NICE)', () => {
    const fake = deps({ ownNice: 10, setPriorityThrows: true })
    expect(applyPtyChildSchedulingPolicy(42, fake.deps).nice).toBe('denied')
  })

  it('does nothing on Windows', () => {
    const fake = deps({ ownNice: 10, platform: 'win32' })
    expect(applyPtyChildSchedulingPolicy(42, fake.deps)).toEqual({
      nice: 'unchanged',
      oomScoreAdj: 'unchanged'
    })
    expect(fake.setPriority).not.toHaveBeenCalled()
  })
})

describe('applyPtyChildSchedulingPolicy OOM preference', () => {
  it('raises the child oom_score_adj on Linux', () => {
    const fake = deps({})
    expect(applyPtyChildSchedulingPolicy(42, fake.deps).oomScoreAdj).toBe('set')
    expect(fake.writeFile).toHaveBeenCalledWith('/proc/42/oom_score_adj', '200')
  })

  it('never lowers a higher value the unit already set', () => {
    const fake = deps({ oomScoreAdj: '500' })
    expect(applyPtyChildSchedulingPolicy(42, fake.deps).oomScoreAdj).toBe('unchanged')
    expect(fake.writeFile).not.toHaveBeenCalled()
  })

  it('is off when configured to 0, and never runs off Linux', () => {
    const off = deps({ env: { ORCA_TERMINAL_OOM_SCORE_ADJ: '0' } })
    applyPtyChildSchedulingPolicy(42, off.deps)
    expect(off.writeFile).not.toHaveBeenCalled()

    const mac = deps({ platform: 'darwin' })
    applyPtyChildSchedulingPolicy(42, mac.deps)
    expect(mac.writeFile).not.toHaveBeenCalled()
  })
})
