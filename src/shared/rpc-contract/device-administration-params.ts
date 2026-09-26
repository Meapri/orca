import { z } from 'zod'
import {
  MAX_PAIRING_OFFER_LIFETIME_MS,
  MIN_PAIRING_OFFER_LIFETIME_MS
} from '../pairing-offer-lifetime'

const DeviceIdParam = z.string().trim().min(1).max(128)
const PairingLifetimeParam = z
  .number()
  .int()
  .min(MIN_PAIRING_OFFER_LIFETIME_MS)
  .max(MAX_PAIRING_OFFER_LIFETIME_MS)
const PairingAddressParam = z.string().trim().min(1).max(2_048)

export const DevicesRevokeParams = z.object({ deviceId: DeviceIdParam }).strict()

export const DevicesRotateParams = z
  .object({
    deviceId: DeviceIdParam,
    address: PairingAddressParam.optional()
  })
  .strict()

export const PairingCreateParams = z
  .object({
    scope: z.enum(['runtime', 'mobile']),
    address: PairingAddressParam.optional(),
    name: z.string().trim().min(1).max(128).optional(),
    expiresInMs: PairingLifetimeParam.optional()
  })
  .strict()
