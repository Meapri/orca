import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { WebPairingOffer } from './web-pairing'
import { listPairingDialEndpoints } from '../../../shared/pairing-endpoint-failover'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'

export type StoredWebRuntimeEnvironment = Omit<PublicKnownRuntimeEnvironment, 'endpoints'> & {
  compatibleEnvironmentIds?: string[]
  endpoints: {
    id: string
    kind: 'websocket'
    label: string
    endpoint: string
    deviceToken: string
    publicKeyB64: string
  }[]
}

const ENVIRONMENT_STORAGE_KEY = 'orca.web.runtimeEnvironment.v1'

export function readStoredWebRuntimeEnvironment(): StoredWebRuntimeEnvironment | null {
  const raw = window.localStorage.getItem(ENVIRONMENT_STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as StoredWebRuntimeEnvironment
    if (
      !parsed.id ||
      !parsed.name ||
      !Array.isArray(parsed.endpoints) ||
      parsed.endpoints.length === 0
    ) {
      return null
    }
    const compatibleEnvironmentIds = Array.isArray(parsed.compatibleEnvironmentIds)
      ? parsed.compatibleEnvironmentIds.filter(
          (environmentId): environmentId is string => typeof environmentId === 'string'
        )
      : []
    const pairedDeviceId =
      typeof parsed.pairedDeviceId === 'string' && parsed.pairedDeviceId.trim().length > 0
        ? parsed.pairedDeviceId.trim()
        : null
    const {
      compatibleEnvironmentIds: _unvalidatedIds,
      pairedDeviceId: _unvalidatedDeviceId,
      ...environment
    } = parsed
    return {
      ...environment,
      ...(pairedDeviceId ? { pairedDeviceId } : {}),
      ...(compatibleEnvironmentIds.length > 0 ? { compatibleEnvironmentIds } : {})
    }
  } catch {
    return null
  }
}

export function saveStoredWebRuntimeEnvironment(environment: StoredWebRuntimeEnvironment): void {
  window.localStorage.setItem(ENVIRONMENT_STORAGE_KEY, JSON.stringify(environment))
}

export function clearStoredWebRuntimeEnvironment(): void {
  window.localStorage.removeItem(ENVIRONMENT_STORAGE_KEY)
}

export function createStoredWebRuntimeEnvironment(args: {
  name: string
  offer: WebPairingOffer
  previousEnvironment?: StoredWebRuntimeEnvironment | null
  connectionDependency?: 'ssh-tunnel'
}): StoredWebRuntimeEnvironment {
  const id = `web-${createBrowserUuid()}`
  const now = Date.now()
  const compatibleEnvironmentIds = getCompatibleEnvironmentIds(args.previousEnvironment, args.offer)
  return {
    id,
    name: args.name.trim() || 'Orca Server',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    runtimeId: null,
    ...(args.offer.pairedDeviceId ? { pairedDeviceId: args.offer.pairedDeviceId } : {}),
    ...(args.connectionDependency ? { connectionDependency: args.connectionDependency } : {}),
    ...(compatibleEnvironmentIds.length > 0 ? { compatibleEnvironmentIds } : {}),
    preferredEndpointId: `ws-${id}`,
    // Why: alternates share the offer's credential and key; the primary stays preferred until a
    // connect to it goes unanswered (same model as the desktop store).
    endpoints: listPairingDialEndpoints(args.offer).map((endpoint, index) => ({
      id: index === 0 ? `ws-${id}` : `ws-${id}-alt-${index}`,
      kind: 'websocket',
      label:
        index === 0
          ? translate('auto.web.web.runtime.environment.07f788de83', 'WebSocket')
          : translate(
              'auto.web.web.runtime.environment.alternateWebSocket',
              'WebSocket (alternate {{value0}})',
              { value0: index }
            ),
      endpoint,
      deviceToken: args.offer.deviceToken,
      publicKeyB64: args.offer.publicKeyB64
    }))
  }
}

function getCompatibleEnvironmentIds(
  previous: StoredWebRuntimeEnvironment | null | undefined,
  offer: WebPairingOffer
): string[] {
  if (!previous?.endpoints.some((endpoint) => endpoint.publicKeyB64 === offer.publicKeyB64)) {
    return []
  }
  return [...new Set([...(previous.compatibleEnvironmentIds ?? []), previous.id])]
}

export function redactStoredWebRuntimeEnvironment(
  environment: StoredWebRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  const { compatibleEnvironmentIds: _compatibleEnvironmentIds, ...publicEnvironment } = environment
  return {
    ...publicEnvironment,
    endpoints: environment.endpoints.map(
      ({ deviceToken: _token, publicKeyB64: _key, ...rest }) => ({
        ...rest
      })
    )
  }
}

export function getPreferredWebPairingOffer(
  environment: StoredWebRuntimeEnvironment
): WebPairingOffer {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!endpoint) {
    throw new Error('No runtime endpoint is stored for this web client.')
  }
  // Why: only entries holding the same credential and key are the same pairing's other addresses.
  const index = environment.endpoints.indexOf(endpoint)
  const alternateEndpoints = [
    ...environment.endpoints.slice(index + 1),
    ...environment.endpoints.slice(0, index)
  ]
    .filter(
      (entry) =>
        entry.deviceToken === endpoint.deviceToken &&
        entry.publicKeyB64 === endpoint.publicKeyB64 &&
        entry.endpoint !== endpoint.endpoint
    )
    .map((entry) => entry.endpoint)
  return {
    v: 2,
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64,
    ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {}),
    ...(alternateEndpoints.length > 0 ? { alternateEndpoints } : {})
  }
}

/**
 * Records the endpoint that just completed a handshake as preferred, so the next page load dials
 * the last good address first. Returns the environment unchanged when it already was preferred.
 */
export function preferConnectedWebEndpoint(
  environment: StoredWebRuntimeEnvironment,
  connectedEndpoint: string
): StoredWebRuntimeEnvironment {
  const preferred = environment.endpoints.find(
    (entry) => entry.id === environment.preferredEndpointId
  )
  if (preferred?.endpoint === connectedEndpoint) {
    return environment
  }
  const connected = environment.endpoints.find((entry) => entry.endpoint === connectedEndpoint)
  if (!connected) {
    return environment
  }
  const next = { ...environment, preferredEndpointId: connected.id }
  saveStoredWebRuntimeEnvironment(next)
  return next
}

export function updateStoredEnvironmentRuntimeId(
  environment: StoredWebRuntimeEnvironment,
  runtimeId: string | null,
  pairedDeviceId?: string
): StoredWebRuntimeEnvironment {
  const next = {
    ...environment,
    runtimeId,
    ...(pairedDeviceId ? { pairedDeviceId } : {}),
    updatedAt: Date.now(),
    lastUsedAt: Date.now()
  }
  saveStoredWebRuntimeEnvironment(next)
  return next
}

export function isMixedContentWebSocket(endpoint: string): boolean {
  return window.location.protocol === 'https:' && endpoint.startsWith('ws://')
}
