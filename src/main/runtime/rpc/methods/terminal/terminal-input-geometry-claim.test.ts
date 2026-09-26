import { describe, expect, it, vi } from 'vitest'
import { chainInputGeometryClaim } from './terminal-input-geometry-claim'

function runtimeClaiming(result: boolean | Error) {
  return {
    claimRemoteDesktopViewerForInput: vi.fn(async () => {
      if (result instanceof Error) {
        throw result
      }
      return result
    })
  }
}

describe('chainInputGeometryClaim', () => {
  it('claims for the typing stream after the prior claim settles', async () => {
    const runtime = runtimeClaiming(true)
    await expect(
      chainInputGeometryClaim(runtime, 'pty', 'key', Promise.resolve(false))
    ).resolves.toBe(true)
    expect(runtime.claimRemoteDesktopViewerForInput).toHaveBeenCalledWith('pty', 'key')
  })

  it('never revokes delivery a prior claim admitted', async () => {
    await expect(
      chainInputGeometryClaim(runtimeClaiming(false), 'pty', 'key', Promise.resolve(true))
    ).resolves.toBe(true)
    await expect(
      chainInputGeometryClaim(
        runtimeClaiming(new Error('boom')),
        'pty',
        'key',
        Promise.resolve(true)
      )
    ).resolves.toBe(true)
  })

  it('keeps refusing when neither the prior claim nor this one admitted input', async () => {
    await expect(
      chainInputGeometryClaim(runtimeClaiming(false), 'pty', 'key', Promise.resolve(false))
    ).resolves.toBe(false)
    await expect(
      chainInputGeometryClaim(runtimeClaiming(false), 'pty', 'key', Promise.reject(new Error('x')))
    ).resolves.toBe(false)
  })
})
