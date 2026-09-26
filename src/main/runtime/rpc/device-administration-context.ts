import type { z } from 'zod'
import type {
  DevicesRotateParams,
  PairingCreateParams
} from '../../../shared/rpc-contract/device-administration-params'
import type {
  DevicesListResult,
  DevicesRevokeResult,
  DevicesRotateResult,
  PairingCreateResult
} from '../../../shared/runtime-device-administration'

/** Present only on requests that arrived over the owner-token local socket. */
export type DeviceAdministrationRpcContext = {
  listDevices(): DevicesListResult
  revokeDevice(deviceId: string): Promise<DevicesRevokeResult>
  rotateDevice(params: z.infer<typeof DevicesRotateParams>): DevicesRotateResult
  createPairingOffer(params: z.infer<typeof PairingCreateParams>): Promise<PairingCreateResult>
}
