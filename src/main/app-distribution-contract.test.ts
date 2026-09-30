import { describe, expect, it } from 'vitest'
import distributionJson from '../shared/app-distribution.json'
import { APP_DISTRIBUTION, APP_DISTRIBUTION_RELEASE_REPO } from '../shared/app-distribution'
import { RUNTIME_DEFAULT_WS_PORT } from '../shared/runtime-default-ws-port'

describe('app distribution identity', () => {
  it('keeps the TS mirror identical to the JSON electron-builder reads', () => {
    expect(APP_DISTRIBUTION).toEqual(distributionJson)
  })

  // Why: each of these is state or an OS registration the official Orca already owns.
  it('never reuses an official Orca identity value', () => {
    expect(APP_DISTRIBUTION.appId).not.toBe('com.stablyai.orca')
    expect(APP_DISTRIBUTION.packageName).not.toBe('orca')
    expect(APP_DISTRIBUTION.packageName).not.toBe('orca-dev')
    expect(APP_DISTRIBUTION.urlScheme).not.toBe('orca')
    expect(['orca', 'orca-dev', 'orca-ide']).not.toContain(APP_DISTRIBUTION.cliCommandName)
    expect(APP_DISTRIBUTION.homeStateDirName).not.toBe('.orca')
    expect([RUNTIME_DEFAULT_WS_PORT, 6769]).not.toContain(
      APP_DISTRIBUTION.desktopRuntimeWebSocketPort
    )
    expect(APP_DISTRIBUTION_RELEASE_REPO).not.toBe('stablyai/orca')
  })

  it('uses identifiers the OS and electron-builder accept', () => {
    expect(APP_DISTRIBUTION.appId).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i)
    expect(APP_DISTRIBUTION.urlScheme).toMatch(/^[a-z][a-z0-9+.-]*$/)
    expect(APP_DISTRIBUTION.packageName).toMatch(/^[a-z0-9-]+$/)
    expect(APP_DISTRIBUTION.cliCommandName).toMatch(/^[a-z0-9-]+$/)
  })
})
