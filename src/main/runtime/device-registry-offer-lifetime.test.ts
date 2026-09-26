import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import type { SecurityEvent } from './security-event-log'

function createRegistry(clock: { now: number }, events: SecurityEvent[] = []) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-offer-'))
  const registry = new DeviceRegistry(userDataPath, {
    now: () => clock.now,
    securityEvents: { record: (event) => events.push(event) }
  })
  return { registry, userDataPath }
}

describe('DeviceRegistry offer lifetime', () => {
  it('admits a minted offer only until its window closes', () => {
    const clock = { now: 1_000 }
    const { registry } = createRegistry(clock)
    const offer = registry.addPendingOffer('cli', 'runtime', 'network', 2_000)

    expect(registry.validateToken(offer.token)?.deviceId).toBe(offer.deviceId)
    clock.now = 2_000
    expect(registry.validateToken(offer.token)).toBeNull()
  })

  it('turns a claimed offer into a paired device that no longer expires', () => {
    const clock = { now: 1_000 }
    const events: SecurityEvent[] = []
    const { registry, userDataPath } = createRegistry(clock, events)
    const offer = registry.addPendingOffer('cli', 'runtime', 'network', 2_000)

    registry.updateLastSeen(offer.deviceId)
    clock.now = 10_000

    expect(registry.validateToken(offer.token)?.deviceId).toBe(offer.deviceId)
    expect(registry.pruneExpiredOffers()).toBe(0)
    expect(events.map((event) => event.event)).toEqual(['pairing.offered', 'pairing.consumed'])
    const persisted: { offerExpiresAt?: number }[] = JSON.parse(
      readFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), 'utf8')
    )
    expect(persisted[0]?.offerExpiresAt).toBeUndefined()
  })

  it('prunes only expired unclaimed offers and records each one', () => {
    const clock = { now: 1_000 }
    const events: SecurityEvent[] = []
    const { registry } = createRegistry(clock, events)
    const expiring = registry.addPendingOffer('short', 'runtime', 'network', 1_500)
    const lasting = registry.addPendingOffer('long', 'mobile', 'network', 9_000)
    const openEnded = registry.getOrCreatePendingDevice('qr', 'mobile')

    clock.now = 1_500
    expect(registry.pruneExpiredOffers()).toBe(1)
    expect(registry.getDevice(expiring.deviceId)).toBeNull()
    expect(registry.getDevice(lasting.deviceId)).not.toBeNull()
    expect(registry.getDevice(openEnded.deviceId)).not.toBeNull()
    expect(events.filter((event) => event.event === 'pairing.expired')).toEqual([
      expect.objectContaining({ deviceId: expiring.deviceId, offerExpiresAt: 1_500 })
    ])
  })

  it('keeps minted offers out of the coalescing QR flows', () => {
    const clock = { now: 1_000 }
    const { registry } = createRegistry(clock)
    const minted = registry.addPendingOffer('cli', 'mobile', 'network', 9_000)

    expect(registry.getPendingDevice('mobile')).toBeNull()
    const qr = registry.getOrCreatePendingDevice('qr', 'mobile')
    expect(qr.deviceId).not.toBe(minted.deviceId)
    registry.rotatePendingDevice('qr again', 'mobile')

    expect(registry.getDevice(minted.deviceId)).not.toBeNull()
    expect(registry.getDevice(qr.deviceId)).toBeNull()
  })

  it('ignores a stale expiry on a device that already paired', () => {
    const clock = { now: 50_000 }
    const { registry: seed, userDataPath } = createRegistry(clock)
    const device = seed.addDevice('phone', 'mobile')
    const registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
    const rows: Record<string, unknown>[] = JSON.parse(readFileSync(registryPath, 'utf8'))
    writeFileSync(registryPath, JSON.stringify([{ ...rows[0], lastSeenAt: 10, offerExpiresAt: 1 }]))

    const reloaded = new DeviceRegistry(userDataPath, { now: () => clock.now })

    expect(reloaded.validateToken(device.token)?.deviceId).toBe(device.deviceId)
    expect(reloaded.getDevice(device.deviceId)?.offerExpiresAt).toBeUndefined()
  })

  it('persists an unclaimed expiry across a reload', () => {
    const clock = { now: 1_000 }
    const { registry, userDataPath } = createRegistry(clock)
    const offer = registry.addPendingOffer('cli', 'runtime', 'network', 2_000)

    const reloaded = new DeviceRegistry(userDataPath, { now: () => 2_500 })

    expect(reloaded.getDevice(offer.deviceId)?.offerExpiresAt).toBe(2_000)
    expect(reloaded.validateToken(offer.token)).toBeNull()
  })

  it('rotates a device token in place', () => {
    const clock = { now: 1_000 }
    const { registry } = createRegistry(clock)
    const device = registry.addDevice('cli', 'runtime')
    registry.updateLastSeen(device.deviceId)

    const rotated = registry.rotateDeviceToken(device.deviceId)

    expect(rotated?.deviceId).toBe(device.deviceId)
    expect(rotated?.token).not.toBe(device.token)
    expect(registry.validateToken(device.token)).toBeNull()
    expect(registry.validateToken(rotated!.token)?.lastSeenAt).toBe(1_000)
    expect(registry.rotateDeviceToken('missing')).toBeNull()
  })
})
