import { publicKeyFromBase64 } from './e2ee'
import { RpcClientSocketSession } from './rpc-client-socket-session'
import { redactSocketEndpoint } from './socket-event-debug'
import type { ConnectionLogEmitter, ConnectionState, RpcResponse } from './types'
import { PairingEndpointRotation } from '../../../src/shared/pairing-endpoint-failover'
import type { ConnectOptions } from './rpc-client'

type SocketFactoryOptions = {
  /** The pairing's addresses; each dial takes the current one, so a failover lands on the next. */
  dial: Pick<ConnectOptions, 'alternateEndpoints' | 'onEndpointConnected'> & { endpoint: string }
  deviceToken: string
  serverPublicKeyB64: string
  getCurrentSocket: () => WebSocket | null
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  getLastConnectedAt: () => number | null
  isIntentionallyClosed: () => boolean
  emitLog: ConnectionLogEmitter
  onHandshakeStarted: () => void
  onAuthenticated: (session: RpcClientSocketSession) => void
  onAuthRejected: (reason: string) => void
  onRpcResponse: (response: RpcResponse) => void
  onBinary: (bytes: Uint8Array) => void
  onAuthenticatedInbound: (session: RpcClientSocketSession) => void
  onClosed: (session: RpcClientSocketSession, closeCode?: number) => void
  onForcedClose: (session: RpcClientSocketSession) => void
}

export class RpcClientSocketFactory {
  private readonly serverPublicKey: Uint8Array
  private lastInboundAt: number | null = null
  private lastSocketClosedAt: number | null = null
  private constructionCount = 0
  private dialStartedAt = 0
  private readonly endpoints: PairingEndpointRotation

  constructor(private readonly options: SocketFactoryOptions) {
    this.serverPublicKey = publicKeyFromBase64(options.serverPublicKeyB64)
    this.endpoints = new PairingEndpointRotation([
      options.dial.endpoint,
      ...(options.dial.alternateEndpoints ?? [])
    ])
  }

  open(): RpcClientSocketSession {
    const now = Date.now()
    const endpoint = this.endpoints.current()
    let opened = false
    let reported = false
    // Why only an unopened dial: an address whose socket opened proves it reaches the host.
    const noteUnanswered = (): void => {
      if (!opened && !reported) {
        reported = true
        this.endpoints.noteConnectFailure(endpoint)
      }
    }
    const lastConnectedAt = this.options.getLastConnectedAt()
    this.constructionCount++
    console.log('[net] openConnection', {
      attempt: this.options.getReconnectAttempt(),
      endpoint: redactSocketEndpoint(endpoint),
      wsCount: this.constructionCount,
      msSinceLastConnected: lastConnectedAt !== null ? now - lastConnectedAt : null,
      msSinceLastClose: this.lastSocketClosedAt !== null ? now - this.lastSocketClosedAt : null,
      msSinceLastInbound: this.lastInboundAt !== null ? now - this.lastInboundAt : null
    })
    this.dialStartedAt = now
    this.options.emitLog(
      'info',
      this.options.getReconnectAttempt() > 0
        ? `Reconnecting (attempt ${this.options.getReconnectAttempt() + 1})`
        : 'Opening WebSocket',
      redactSocketEndpoint(endpoint)
    )
    return new RpcClientSocketSession({
      endpoint,
      deviceToken: this.options.deviceToken,
      serverPublicKey: this.serverPublicKey,
      getCurrentSocket: this.options.getCurrentSocket,
      getState: this.options.getState,
      getReconnectAttempt: this.options.getReconnectAttempt,
      isIntentionallyClosed: this.options.isIntentionallyClosed,
      emitLog: this.options.emitLog,
      onHandshakeStarted: () => {
        opened = true
        this.options.onHandshakeStarted()
      },
      onAuthenticated: (session) => {
        this.endpoints.noteConnected(endpoint)
        this.options.dial.onEndpointConnected?.(endpoint)
        this.options.onAuthenticated(session)
      },
      onAuthRejected: this.options.onAuthRejected,
      onRpcResponse: this.options.onRpcResponse,
      onBinary: this.options.onBinary,
      onAnyInbound: (receivedAt) => (this.lastInboundAt = receivedAt),
      onAuthenticatedInbound: this.options.onAuthenticatedInbound,
      onClosed: (session, closeCode) => {
        noteUnanswered()
        this.options.onClosed(session, closeCode)
      },
      onForcedClose: (session) => {
        noteUnanswered()
        this.options.onForcedClose(session)
      }
    })
  }

  getDialStartedAt(): number {
    return this.dialStartedAt
  }

  noteClosed(): void {
    this.lastSocketClosedAt = Date.now()
  }
}
