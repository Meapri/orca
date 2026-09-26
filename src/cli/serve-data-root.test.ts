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
