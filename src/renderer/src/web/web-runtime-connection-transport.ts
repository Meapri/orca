import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { withReconnectJitter } from '../../../shared/reconnect-jitter'
import { WebRuntimeConnectionHeartbeat } from './web-runtime-connection-heartbeat'
import {
  routeWebRuntimeConnectionFrame,
  type WebRuntimeConnectionState
} from './web-runtime-connection-frame-router'
import { createWebRuntimeUnauthorizedError } from './web-runtime-client-error'
import {
  deriveSharedKey,
  encrypt,
  encryptBytes,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './web-e2ee'
import type { WebPairingOffer } from './web-pairing'
import type { WebRuntimeTransportSubscription } from './web-runtime-subscription-contract'
import { WebRuntimeSubscriptionRegistry } from './web-runtime-subscription-registry'
import { WebRuntimeRequestRegistry } from './web-runtime-request-registry'
import { WebRuntimeConnectionWaiters } from './web-runtime-connection-waiters'
import {
  listPairingDialEndpoints,
  PairingEndpointRotation
} from '../../../shared/pairing-endpoint-failover'
import { REMOTE_RUNTIME_SOCKET_RESUME_PROBE_DEADLINE_MS } from '../../../shared/remote-runtime-socket-liveness'
import { registerWebRuntimeResumeTarget } from './web-runtime-resume-signals'

const CONNECT_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000]

export class WebRuntimeConnectionTransport {
  ws: WebSocket | null = null
  sharedKey: Uint8Array | null = null
  state: WebRuntimeConnectionState = 'disconnected'
  readonly subscriptions: Map<string, WebRuntimeTransportSubscription>
  readonly heartbeat: WebRuntimeConnectionHeartbeat
  private requestCounter = 0
  private reconnectAttempt = 0
  private intentionallyClosed = false
  private connectTimer: number | null = null
  private handshakeTimer: number | null = null
  private reconnectTimer: number | null = null
  private readonly serverPublicKey: Uint8Array
  private readonly subscriptionRegistry: WebRuntimeSubscriptionRegistry
  private readonly requestRegistry: WebRuntimeRequestRegistry
  private readonly connectionWaiters: WebRuntimeConnectionWaiters
  private readonly endpoints: PairingEndpointRotation
  // Why: one pass tries each paired address once before the backoff applies, so an unreachable
  // primary costs one connect timeout rather than a whole backoff ladder.
  private readonly unansweredThisPass = new Set<string>()
  private dialEndpoint: string
  private readonly unregisterResumeTarget: () => void

  constructor(
    private readonly pairing: WebPairingOffer,
    clock: { now: () => number; isDocumentVisible: () => boolean },
    private readonly lifecycle: {
      onStateChanged?: (state: WebRuntimeConnectionState) => void
      /** The endpoint that just completed a handshake, so the caller can keep it preferred. */
      onEndpointConnected?: (endpoint: string) => void
      reconnect?: boolean
    } = {}
  ) {
    this.serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
    this.endpoints = new PairingEndpointRotation(listPairingDialEndpoints(pairing))
    this.dialEndpoint = this.endpoints.current()
    this.unregisterResumeTarget = registerWebRuntimeResumeTarget(this)
    this.connectionWaiters = new WebRuntimeConnectionWaiters({
      endpoint: pairing.endpoint,
      getState: () => this.state,
      isIntentionallyClosed: () => this.intentionallyClosed
    })
    this.subscriptionRegistry = new WebRuntimeSubscriptionRegistry({
      deviceToken: pairing.deviceToken,
      nextId: () => this.nextId(),
      sendEncrypted: (message) => this.sendEncrypted(message)
    })
    this.subscriptions = this.subscriptionRegistry.subscriptions
    this.requestRegistry = new WebRuntimeRequestRegistry({
      deviceToken: pairing.deviceToken,
      nextId: () => this.nextId(),
      waitForConnected: (timeoutMs, signal) => this.connectionWaiters.wait(timeoutMs, signal),
      sendEncrypted: (message) => this.sendEncrypted(message)
    })
    this.heartbeat = new WebRuntimeConnectionHeartbeat({
      now: clock.now,
      isDocumentVisible: clock.isDocumentVisible,
      isConnected: () => this.state === 'connected',
      getSocket: () => this.ws,
      sendProbe: () =>
        this.sendEncrypted({
          id: `web-heartbeat-${this.nextId()}`,
          deviceToken: this.pairing.deviceToken,
          method: 'status.get'
        }),
      handleDeadSocket: (socket) => this.handleSocketClosed(socket)
    })
    this.openConnection()
  }

  async call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RuntimeRpcResponse<unknown>> {
    return this.requestRegistry.call(method, params, options)
  }

  close(options: { notifySubscriptions?: boolean } = {}): void {
    this.intentionallyClosed = true
    this.unregisterResumeTarget()
    this.clearTimers()
    this.requestRegistry.rejectAll('Remote Orca runtime connection closed.')
    this.connectionWaiters.rejectAll(new Error('Remote Orca runtime connection closed.'))
    this.subscriptionRegistry.close(options.notifySubscriptions ?? true)
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.sharedKey = null
    this.setState('disconnected')
  }

  async handleSocketMessage(rawData: unknown, sourceWs?: WebSocket): Promise<void> {
    await routeWebRuntimeConnectionFrame(rawData, sourceWs, {
      getState: () => this.state,
      getSharedKey: () => this.sharedKey,
      getSocket: () => this.ws,
      pairingToken: this.pairing.deviceToken,
      pending: this.requestRegistry.pending,
      subscriptions: this.subscriptions,
      sendEncrypted: (message) => this.sendEncrypted(message),
      setConnected: () => {
        this.clearHandshakeTimer()
        this.reconnectAttempt = 0
        this.unansweredThisPass.clear()
        this.endpoints.noteConnected(this.dialEndpoint)
        this.setState('connected')
        this.lifecycle.onEndpointConnected?.(this.dialEndpoint)
      },
      setAuthFailed: () => {
        this.intentionallyClosed = true
        this.setState('auth-failed')
      },
      rejectUnauthorized: (error) => this.requestRegistry.rejectAll(error),
      notifyUnauthorized: () =>
        this.notifySubscriptionsError('unauthorized', 'Unauthorized. Pair this web client again.')
    })
  }

  handleSocketClosed(closedWs: WebSocket): void {
    if (this.ws !== closedWs) {
      return
    }
    // Why only before open: an endpoint whose socket opened proves this address reaches the host.
    const unanswered = this.state === 'connecting'
    this.ws = null
    this.sharedKey = null
    this.clearConnectTimer()
    this.clearHandshakeTimer()
    this.heartbeat.clear()
    this.requestRegistry.rejectAll('Remote Orca runtime connection interrupted.')
    this.subscriptionRegistry.handleInterrupted()
    if (this.intentionallyClosed || this.state === 'auth-failed') {
      this.setState(this.state === 'auth-failed' ? 'auth-failed' : 'disconnected')
      return
    }
    this.setState('disconnected')
    if (unanswered && this.tryNextEndpointNow()) {
      return
    }
    this.scheduleReconnect()
  }

  /** After a resume signal: probe a live socket quickly, or skip the remaining backoff wait. */
  reviveAfterResume(): void {
    if (this.intentionallyClosed || this.state === 'auth-failed') {
      return
    }
    if (this.state === 'connected') {
      this.heartbeat.probeNow(REMOTE_RUNTIME_SOCKET_RESUME_PROBE_DEADLINE_MS)
      return
    }
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.reconnectAttempt = 0
      this.unansweredThisPass.clear()
      this.openConnection()
    }
  }

  private tryNextEndpointNow(): boolean {
    this.unansweredThisPass.add(this.dialEndpoint)
    if (!this.endpoints.noteConnectFailure(this.dialEndpoint)) {
      return false
    }
    if (this.unansweredThisPass.has(this.endpoints.current())) {
      // Why: every address went unanswered this pass; the backoff decides when to start the next.
      this.unansweredThisPass.clear()
      return false
    }
    this.openConnection()
    return true
  }

  setState(next: WebRuntimeConnectionState): void {
    this.state = next
    if (next === 'connected') {
      this.subscriptionRegistry.replayInterrupted()
      this.heartbeat.start()
      this.connectionWaiters.resolveAll()
    } else if (next === 'auth-failed') {
      this.connectionWaiters.rejectAll(createWebRuntimeUnauthorizedError())
    }
    this.lifecycle.onStateChanged?.(next)
  }

  private openConnection(): void {
    if (this.intentionallyClosed) {
      return
    }
    let socket: WebSocket
    this.dialEndpoint = this.endpoints.current()
    try {
      socket = new WebSocket(this.dialEndpoint)
    } catch (error) {
      this.requestRegistry.rejectAll(error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.ws = socket
    this.sharedKey = null
    this.setState('connecting')
    this.connectTimer = window.setTimeout(() => {
      if (this.ws === socket && socket.readyState === WebSocket.CONNECTING) {
        socket.close()
        this.handleSocketClosed(socket)
      }
    }, CONNECT_TIMEOUT_MS)
    socket.onopen = () => {
      if (this.ws !== socket) {
        return
      }
      this.clearConnectTimer()
      this.setState('handshaking')
      const keyPair = generateKeyPair()
      this.sharedKey = deriveSharedKey(keyPair.secretKey, this.serverPublicKey)
      socket.send(
        JSON.stringify({ type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(keyPair.publicKey) })
      )
      this.handshakeTimer = window.setTimeout(() => {
        if (this.ws === socket && this.state === 'handshaking') {
          socket.close()
        }
      }, HANDSHAKE_TIMEOUT_MS)
    }
    socket.onmessage = (event) => {
      if (this.ws !== socket) {
        return
      }
      this.heartbeat.noteInboundFrame()
      void this.handleSocketMessage(event.data, socket)
    }
    socket.onclose = () => this.handleSocketClosed(socket)
    socket.onerror = () => {
      // Why: while another paired address is still untried, the connect is not yet a failure.
      if (this.state === 'connecting' && !this.hasUntriedEndpoint()) {
        this.connectionWaiters.rejectUnavailable()
      }
    }
  }

  /** The pairing re-ordered so the address that last answered is dialed first. */
  currentPairing(): WebPairingOffer {
    const endpoint = this.endpoints.current()
    const alternateEndpoints = this.endpoints.alternatesAfter(endpoint)
    const { alternateEndpoints: _previous, ...pairing } = this.pairing
    return {
      ...pairing,
      endpoint,
      ...(alternateEndpoints.length > 0 ? { alternateEndpoints } : {})
    }
  }

  private hasUntriedEndpoint(): boolean {
    return this.endpoints.size > this.unansweredThisPass.size + 1
  }

  sendEncrypted(message: unknown): boolean {
    const socket = this.ws
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.sharedKey) {
      return false
    }
    socket.send(encrypt(JSON.stringify(message), this.sharedKey))
    return true
  }

  sendEncryptedBinary(bytes: Uint8Array<ArrayBufferLike>): boolean {
    const socket = this.ws
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.sharedKey) {
      return false
    }
    socket.send(encryptBytes(bytes, this.sharedKey))
    return true
  }

  waitForConnected(timeoutMs = 30_000): Promise<void> {
    return this.connectionWaiters.wait(timeoutMs)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionallyClosed || this.lifecycle.reconnect === false) {
      return
    }
    const delay = withReconnectJitter(
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.openConnection()
    }, delay)
  }

  nextId(): string {
    this.requestCounter += 1
    return `web-rpc-${this.requestCounter}-${Date.now()}`
  }

  private notifySubscriptionsError(code: string, message: string): void {
    this.subscriptionRegistry.notifyError(code, message)
  }

  private clearTimers(): void {
    this.clearConnectTimer()
    this.clearHandshakeTimer()
    this.heartbeat.clear()
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearConnectTimer(): void {
    if (!this.connectTimer) {
      return
    }
    window.clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private clearHandshakeTimer(): void {
    if (!this.handshakeTimer) {
      return
    }
    window.clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }
}
