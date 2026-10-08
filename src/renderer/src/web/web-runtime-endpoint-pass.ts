import {
  listPairingDialEndpoints,
  PairingEndpointRotation
} from '../../../shared/pairing-endpoint-failover'
import type { WebPairingOffer } from './web-pairing'

/**
 * Which paired address the web transport dials. One pass tries each address once, immediately,
 * before the reconnect backoff applies — an unreachable primary costs one connect timeout rather
 * than a whole backoff ladder — and the address that completes a handshake stays first.
 */
export class WebRuntimeEndpointPass {
  private readonly rotation: PairingEndpointRotation
  private readonly unansweredThisPass = new Set<string>()
  private dialing: string

  constructor(private readonly pairing: WebPairingOffer) {
    this.rotation = new PairingEndpointRotation(listPairingDialEndpoints(pairing))
    this.dialing = this.rotation.current()
  }

  /** The address for the dial about to start. */
  beginDial(): string {
    this.dialing = this.rotation.current()
    return this.dialing
  }

  get dialed(): string {
    return this.dialing
  }

  noteConnected(): void {
    this.unansweredThisPass.clear()
    this.rotation.noteConnected(this.dialing)
  }

  /** After an unanswered dial: true when another address of this pass should be dialed now. */
  advanceAfterUnanswered(): boolean {
    this.unansweredThisPass.add(this.dialing)
    if (!this.rotation.noteConnectFailure(this.dialing)) {
      return false
    }
    if (this.unansweredThisPass.has(this.rotation.current())) {
      // Why: every address went unanswered this pass; the backoff decides when to start the next.
      this.unansweredThisPass.clear()
      return false
    }
    return true
  }

  /** Whether an address other than the one being dialed is still untried in this pass. */
  hasUntried(): boolean {
    return this.rotation.size > this.unansweredThisPass.size + 1
  }

  restartPass(): void {
    this.unansweredThisPass.clear()
  }

  /** The pairing re-ordered so the address that last answered is dialed first. */
  currentPairing(): WebPairingOffer {
    const endpoint = this.rotation.current()
    const alternateEndpoints = this.rotation.alternatesAfter(endpoint)
    const { alternateEndpoints: _previous, ...pairing } = this.pairing
    return {
      ...pairing,
      endpoint,
      ...(alternateEndpoints.length > 0 ? { alternateEndpoints } : {})
    }
  }
}
