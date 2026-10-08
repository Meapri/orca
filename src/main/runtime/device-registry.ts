// Why: per-device tokens replace the shared runtime auth token for WebSocket
// (mobile) connections. Each paired device gets its own revocable token so
// compromising one device doesn't expose others. The registry is a simple
// JSON file with hardened permissions matching the runtime metadata pattern.
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DeviceScope } from '../../shared/runtime-types'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { MobilePushRegistration } from '../../shared/mobile-push-contract'
import type { SecurityEventSink } from './security-event-log'
import { isExpiredOffer, isOpenEndedPendingDevice } from './device-registry-entry-parsing'
import { DeviceRegistryFile } from './device-registry-file'

export type { DeviceScope }

export type DeviceEntry = {
  deviceId: string
  name: string
  token: string
  scope: DeviceScope
  pairedAt: number
  lastSeenAt: number
  relayBinding?: RelayDeviceBinding
  mobilePairingConnectionMode?: MobilePairingConnectionMode
  // Why: STA-2370 — a grant minted for "This computer only" proves nothing about off-host reach when its
  // client connects, so the bind decision must be able to tell it apart from a LAN/phone grant.
  pairingReach?: RuntimePairingReach
  // Why: survives a desktop restart so the host can keep pushing without the phone
  // re-registering. Absent on every registry written before background push existed.
  pushRegistration?: MobilePushRegistration
  // Why: a minted offer is a bearer credential not yet claimed; past this instant it stops authenticating.
  offerExpiresAt?: number
}

export type DeviceRegistryOptions = {
  securityEvents?: SecurityEventSink
  now?: () => number
}

// Why: a lastSeen refresh is pure bookkeeping, so coalesce reconnect bursts into one write instead of
// paying a secure-file rewrite (two synchronous PowerShell ACL spawns on Windows) per connection.
const LAST_SEEN_FLUSH_DELAY_MS = 250
const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export class DeviceRegistry {
  private readonly file: DeviceRegistryFile
  private devices: DeviceEntry[] = []
  private pendingLastSeenFlush: NodeJS.Timeout | null = null
  private readonly securityEvents: SecurityEventSink | null
  private readonly now: () => number

  constructor(userDataPath: string, options: DeviceRegistryOptions = {}) {
    const registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
    this.file = new DeviceRegistryFile(registryPath)
    this.securityEvents = options.securityEvents ?? null
    this.now = options.now ?? Date.now
    // Why: a write killed between writeFile and rename (e.g. a hung icacls, #20497) orphans its temp forever.
    void removeStaleDurableWriteTempFiles(registryPath, { minimumAgeMs: STALE_WRITE_TEMP_AGE_MS })
    this.devices = this.file.read()
  }

  addDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network'
  ): DeviceEntry {
    return this.createAndPersistDevice(this.devices, name, scope, pairingReach)
  }

  /** Mints a standalone offer that the coalescing QR/link flows never reuse, rotate, or extend. */
  addPendingOffer(
    name: string,
    scope: DeviceScope,
    pairingReach: RuntimePairingReach,
    offerExpiresAt: number
  ): DeviceEntry {
    this.pruneExpiredOffers()
    return this.createAndPersistDevice(this.devices, name, scope, pairingReach, offerExpiresAt)
  }

  private createAndPersistDevice(
    existingDevices: DeviceEntry[],
    name: string,
    scope: DeviceScope,
    pairingReach: RuntimePairingReach,
    offerExpiresAt?: number
  ): DeviceEntry {
    const entry: DeviceEntry = {
      deviceId: randomUUID(),
      name,
      token: randomBytes(24).toString('hex'),
      scope,
      pairedAt: this.now(),
      lastSeenAt: 0,
      pairingReach,
      ...(offerExpiresAt !== undefined ? { offerExpiresAt } : {})
    }
    const nextDevices = [...existingDevices, entry]
    // Why: a credential is not valid until its durable registry write succeeds.
    this.save(nextDevices)
    this.devices = nextDevices
    this.securityEvents?.record({
      event: 'pairing.offered',
      deviceId: entry.deviceId,
      scope,
      name,
      offerExpiresAt: offerExpiresAt ?? null
    })
    return entry
  }

  // Why: coalesce repeated QR-regenerate clicks onto a single pending token.
  // Each call to addDevice() produces a valid auth credential; without
  // coalescing, every renderer call to mobile:getPairingQR (e.g. the new
  // copy-button flow that encourages regeneration) leaves an orphaned token
  // forever. Returns an existing never-scanned entry if present; otherwise
  // mints a new one and drops any stale pending entries.
  getOrCreatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network'
  ): DeviceEntry {
    const existing = this.devices.find((d) => isOpenEndedPendingDevice(d) && d.scope === scope)
    if (existing) {
      // Why: the same pending token can be re-advertised at a broader reach; widen it but never narrow it,
      // or a link already handed out for off-host use would stop being served after the next launch.
      return pairingReach === 'network' && existing.pairingReach === 'this-computer'
        ? this.setPairingReach(existing, 'network')
        : existing
    }
    return this.addDevice(name, scope, pairingReach)
  }

  private setPairingReach(existing: DeviceEntry, pairingReach: RuntimePairingReach): DeviceEntry {
    const updated: DeviceEntry = { ...existing, pairingReach }
    const nextDevices = this.devices.map((device) =>
      device.deviceId === existing.deviceId ? updated : device
    )
    // Why: persist before the memory swap so a failed write cannot leave the bind decision reading a
    // reach that never reached disk.
    this.save(nextDevices)
    this.devices = nextDevices
    return updated
  }

  // Why: explicit rotation path for "Regenerate QR" — invalidates any
  // existing never-scanned token (e.g. one that was screenshotted, copied
  // to clipboard, or shown on a screen-share) and mints a fresh one. Without
  // this, getOrCreatePendingDevice keeps returning the same token forever
  // until a phone actually pairs, so users have no way to revoke a leaked
  // pre-pairing token.
  rotatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network'
  ): DeviceEntry {
    const superseded = this.devices.filter((d) => isOpenEndedPendingDevice(d) && d.scope === scope)
    const retainedDevices = this.devices.filter((d) => !superseded.includes(d))
    const entry = this.createAndPersistDevice(retainedDevices, name, scope, pairingReach)
    for (const device of superseded) {
      this.securityEvents?.record({ event: 'pairing.superseded', deviceId: device.deviceId, scope })
    }
    return entry
  }

  /** Drops minted offers whose window closed unclaimed. Returns how many were removed. */
  pruneExpiredOffers(): number {
    const now = this.now()
    const expired = this.devices.filter((device) => isExpiredOffer(device, now))
    if (expired.length === 0) {
      return 0
    }
    const nextDevices = this.devices.filter((device) => !expired.includes(device))
    this.save(nextDevices)
    this.devices = nextDevices
    for (const device of expired) {
      this.securityEvents?.record({
        event: 'pairing.expired',
        deviceId: device.deviceId,
        scope: device.scope,
        offerExpiresAt: device.offerExpiresAt ?? null
      })
    }
    return expired.length
  }

  /** Replaces a device's bearer token in place; identity, scope and history are kept. */
  rotateDeviceToken(deviceId: string): DeviceEntry | null {
    const current = this.getDevice(deviceId)
    if (!current) {
      return null
    }
    const updated: DeviceEntry = { ...current, token: randomBytes(24).toString('hex') }
    const nextDevices = this.devices.map((device) => (device === current ? updated : device))
    // Why: persist before the swap so the old token never outlives a failed write in memory only.
    this.save(nextDevices)
    this.devices = nextDevices
    return updated
  }

  removeDevice(deviceId: string): boolean {
    const nextDevices = this.devices.filter((d) => d.deviceId !== deviceId)
    if (nextDevices.length === this.devices.length) {
      return false
    }
    // Why: persist before memory swap so a failed write does not drop a device
    // only in-process while disk still lists it (and vice versa on reload).
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  getDevice(deviceId: string): DeviceEntry | null {
    return this.devices.find((d) => d.deviceId === deviceId) ?? null
  }

  getPendingDevice(scope: DeviceScope = 'mobile'): DeviceEntry | null {
    return (
      this.devices.find((device) => isOpenEndedPendingDevice(device) && device.scope === scope) ??
      null
    )
  }

  setRelayBinding(deviceId: string, binding: RelayDeviceBinding): boolean {
    const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
    if (index === -1 || binding.relayDeviceId !== deviceId) {
      return false
    }
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, relayBinding: binding } : device
    )
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  /** Passing null clears the registration (unregister, or a token the gateway reported dead). */
  setPushRegistration(deviceId: string, registration: MobilePushRegistration | null): boolean {
    const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
    if (index === -1 || this.devices[index]?.scope !== 'mobile') {
      return false
    }
    const nextDevices = this.devices.map((device, candidateIndex) => {
      if (candidateIndex !== index) {
        return device
      }
      const { pushRegistration: _dropped, ...rest } = device
      return registration ? { ...rest, pushRegistration: registration } : rest
    })
    // Why: persist before the memory swap so a failed write cannot leave the dispatcher
    // pushing to a registration disk says is gone (or vice versa on reload).
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  setMobilePairingConnectionMode(deviceId: string, mode: MobilePairingConnectionMode): boolean {
    const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
    if (index === -1 || this.devices[index]?.scope !== 'mobile') {
      return false
    }
    // Why: persist before swapping memory so a failed write does not leave a
    // mode the UI/runtime believe was stored.
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, mobilePairingConnectionMode: mode } : device
    )
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  getMobilePairingConnectionMode(deviceId: string): MobilePairingConnectionMode | null {
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId)
    if (!device || device.scope !== 'mobile') {
      return null
    }
    // Why: pairings created before this preference existed used automatic
    // direct-first Relay fallback, so missing state must preserve that behavior.
    return device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic'
  }

  listDevices(): readonly DeviceEntry[] {
    return this.devices
  }

  validateToken(token: string): DeviceEntry | null {
    const device = this.devices.find((d) => d.token === token) ?? null
    return device && isExpiredOffer(device, this.now()) ? null : device
  }

  updateLastSeen(deviceId: string): void {
    const index = this.devices.findIndex((d) => d.deviceId === deviceId)
    if (index === -1) {
      return
    }
    // Why: persist before memory swap so a failed write cannot leave a scanned
    // device looking never-scanned on disk, where rotation would drop it.
    const seenAt = this.now()
    const previous = this.devices[index]!
    const { offerExpiresAt: _consumedExpiry, ...consumed } = previous
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...consumed, lastSeenAt: seenAt } : device
    )
    this.save(nextDevices)
    this.devices = nextDevices
    this.cancelPendingLastSeenFlush()
    if (previous.lastSeenAt === 0) {
      this.securityEvents?.record({
        event: 'pairing.consumed',
        deviceId: previous.deviceId,
        scope: previous.scope,
        name: previous.name
      })
    }
  }

  /**
   * Marks a device seen without blocking the caller on disk — the E2EE auth handshake runs this, and on
   * Windows every save spawns PowerShell synchronously to reapply the registry's ACL.
   * The first-ever sighting still persists inline: rotatePendingDevice drops entries that disk says were
   * never scanned, so only that 0 -> non-zero transition is load-bearing.
   */
  updateLastSeenDeferred(deviceId: string): void {
    const index = this.devices.findIndex((d) => d.deviceId === deviceId)
    if (index === -1) {
      return
    }
    if (this.devices[index]!.lastSeenAt === 0) {
      this.updateLastSeen(deviceId)
      return
    }
    const seenAt = this.now()
    this.devices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, lastSeenAt: seenAt } : device
    )
    if (this.pendingLastSeenFlush) {
      return
    }
    this.pendingLastSeenFlush = setTimeout(
      () => this.flushPendingLastSeen(),
      LAST_SEEN_FLUSH_DELAY_MS
    )
    // Why: bookkeeping must never hold the process open.
    this.pendingLastSeenFlush.unref?.()
  }

  /** Persists a deferred lastSeen refresh now; no-op when nothing is pending. */
  flushPendingLastSeen(): void {
    if (!this.pendingLastSeenFlush) {
      return
    }
    this.cancelPendingLastSeenFlush()
    try {
      this.save(this.devices)
    } catch (error) {
      // Why: matches the async hardening path — a failed bookkeeping write must not take down the runtime.
      console.error('[mobile] Failed to persist device lastSeen:', error)
    }
  }

  private cancelPendingLastSeenFlush(): void {
    if (this.pendingLastSeenFlush) {
      clearTimeout(this.pendingLastSeenFlush)
      this.pendingLastSeenFlush = null
    }
  }

  private save(devices: DeviceEntry[]): void {
    this.file.write(devices)
    // Why: every registry save includes the latest in-memory timestamps, so a later timer would rewrite it.
    this.cancelPendingLastSeenFlush()
  }
}
