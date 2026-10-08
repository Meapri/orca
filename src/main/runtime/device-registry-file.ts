import { existsSync, readFileSync } from 'node:fs'
import {
  hardenExistingSecureFile,
  isUnreadableError,
  writeSecureJsonFile
} from '../../shared/secure-file'
import type { DeviceEntry } from './device-registry'
import { normalizeLoadedDeviceEntry } from './device-registry-entry-parsing'

/** The registry's on-disk half: hardened JSON that refuses to overwrite what it could not read. */
export class DeviceRegistryFile {
  /** Set when the registry exists but could not be read, which makes an empty list a lie to save from. */
  private unreadable = false

  constructor(private readonly path: string) {}

  read(): DeviceEntry[] {
    if (!existsSync(this.path)) {
      return []
    }
    try {
      hardenExistingSecureFile(this.path)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every row is re-normalized field by field below.
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as DeviceEntry[]
      this.unreadable = false
      return parsed.map(normalizeLoadedDeviceEntry)
    } catch (error) {
      // "Cannot read" is not "is empty". Saving an empty list over a registry we were merely
      // denied would erase every paired device's bearer token, and the write would succeed.
      this.unreadable = isUnreadableError(error)
      return []
    }
  }

  write(devices: DeviceEntry[]): void {
    if (this.unreadable) {
      throw new Error(
        `Cannot read the device registry at ${this.path}: the read failed. Refusing to overwrite it, which would revoke every paired device.`
      )
    }
    writeSecureJsonFile(this.path, devices)
  }
}
