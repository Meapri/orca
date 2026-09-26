import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRuntimeMetadataPath } from '../shared/runtime-bootstrap'
import { resolveServeDataRoot } from './serve-data-root'

const saved = {
  ORCA_USER_DATA: process.env.ORCA_USER_DATA,
  ORCA_USER_DATA_PATH: process.env.ORCA_USER_DATA_PATH,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
})

describe('resolveServeDataRoot', () => {
  it('prefers --data-root, then ORCA_USER_DATA, then ORCA_USER_DATA_PATH', () => {
    process.env.ORCA_USER_DATA = '/srv/orcad'
    process.env.ORCA_USER_DATA_PATH = '/home/orca/.config/orca'

    expect(resolveServeDataRoot(new Map([['data-root', '/explicit']]))).toBe('/explicit')
    expect(resolveServeDataRoot(new Map())).toBe('/srv/orcad')
    delete process.env.ORCA_USER_DATA
    expect(resolveServeDataRoot(new Map())).toBe('/home/orca/.config/orca')
  })

  it('picks the orcad default root when a runtime published metadata there', () => {
    delete process.env.ORCA_USER_DATA
    delete process.env.ORCA_USER_DATA_PATH
    const xdg = mkdtempSync(join(tmpdir(), 'orca-xdg-'))
    process.env.XDG_DATA_HOME = xdg
    const orcadRoot = join(xdg, 'Orca')
    mkdirSync(orcadRoot)
    writeFileSync(getRuntimeMetadataPath(orcadRoot), '{}')

    expect(resolveServeDataRoot(new Map())).toBe(orcadRoot)
  })

  it('rejects an empty --data-root instead of silently using a default', () => {
    expect(() => resolveServeDataRoot(new Map([['data-root', true]]))).toThrow('--data-root')
  })
})

describe('resolveServeDataRoot discovery', () => {
  const HOME = '/home/orca'
  const DESKTOP_ROOT = join(HOME, '.config', 'orca')
  const ORCAD_ROOT = join(HOME, '.orca')

  function resolve(env: Record<string, string>, live: string[]): string {
    // Why: getDefaultUserDataPath also reads the ambient variable an Orca terminal exports.
    delete process.env.ORCA_USER_DATA_PATH
    return resolveServeDataRoot(new Map(), {
      env,
      platform: 'linux',
      homeDir: HOME,
      hasMetadata: (path) => live.includes(path)
    })
  }

  it('prefers explicit env over any discovery', () => {
    expect(resolve({ ORCA_USER_DATA: '/b', ORCA_USER_DATA_PATH: '/a' }, [ORCAD_ROOT])).toBe('/b')
    expect(resolve({ ORCA_USER_DATA_PATH: '/a' }, [DESKTOP_ROOT])).toBe('/a')
  })

  it('finds a running orcad first, then a running desktop runtime', () => {
    expect(resolve({}, [ORCAD_ROOT])).toBe(ORCAD_ROOT)
    expect(resolve({}, [DESKTOP_ROOT, ORCAD_ROOT])).toBe(ORCAD_ROOT)
    expect(resolve({}, [DESKTOP_ROOT])).toBe(DESKTOP_ROOT)
    expect(resolve({ XDG_DATA_HOME: '/srv/data' }, [join('/srv/data', 'Orca')])).toBe(
      join('/srv/data', 'Orca')
    )
  })

  it('falls back to the orcad root when no runtime published metadata', () => {
    expect(resolve({}, [])).toBe(ORCAD_ROOT)
  })
})
