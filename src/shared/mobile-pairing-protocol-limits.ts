export const PAIRING_CODE_MAX_CHARACTERS = 128 * 1024
export const PAIRING_INPUT_MAX_CHARACTERS = PAIRING_CODE_MAX_CHARACTERS + 1024
export const PAIRING_ENDPOINT_MAX_CHARACTERS = 16 * 1024
// Why: each alternate is a dial a client may try in turn; a handful covers configured, tailnet and LAN.
export const PAIRING_ALTERNATE_ENDPOINTS_MAX = 8
export const PAIRING_DEVICE_TOKEN_MAX_CHARACTERS = 64 * 1024
export const PAIRING_PUBLIC_KEY_MAX_CHARACTERS = 4 * 1024
export const PAIRING_RELAY_URL_MAX_CHARACTERS = 2048
