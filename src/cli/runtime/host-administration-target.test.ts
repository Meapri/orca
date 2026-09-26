import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveHostAdministrationUserDataPath } from './host-administration-target'

const HOME = '/home/orca'
const DESKTOP_ROOT = join(HOME, '.config', 'orca')
const ORCAD_ROOT = join(HOME, '.orca')

function resolve(env: Record<string, string>, live: string[]): string {
  const saved = process.env.ORCA_USER_DATA_PATH
  delete process.env.ORCA_USER_DATA_PATH
  try {
    return resolveHostAdministrationUserDataPath(env, 'linux', HOME, (path) => live.includes(path))
  } finally {
    if (saved !== undefined) {
      process.env.ORCA_USER_DATA_PATH = saved
    }
  }
}

describe('resolveHostAdministrationUserDataPath', () => {
  it('prefers explicit env over any discovery', () => {
    expect(resolve({ ORCA_USER_DATA_PATH: '/a', ORCA_USER_DATA: '/b' }, [ORCAD_ROOT])).toBe('/a')
    expect(resolve({ ORCA_USER_DATA: '/b' }, [DESKTOP_ROOT])).toBe('/b')
  })

  it('finds a running orcad when no desktop runtime is live', () => {
    expect(resolve({}, [ORCAD_ROOT])).toBe(ORCAD_ROOT)
    expect(resolve({ XDG_DATA_HOME: '/srv/data' }, [join('/srv/data', 'Orca')])).toBe(
      join('/srv/data', 'Orca')
    )
  })

  it('keeps the desktop default when it is live or when nothing is', () => {
    expect(resolve({}, [DESKTOP_ROOT, ORCAD_ROOT])).toBe(DESKTOP_ROOT)
    expect(resolve({}, [])).toBe(DESKTOP_ROOT)
  })
})
