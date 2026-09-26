import type { OrcaRuntimeService } from '../../../orca-runtime'

/**
 * Queues a host-side geometry claim for a desktop stream's input, ahead of the input itself.
 *
 * Why host-side: clients that negotiated explicit claims already send ClaimViewport on activity,
 * but older ones never do, so ownership stayed with whoever resized last and their typing landed
 * at another client's width. The claim result only ever widens delivery: input a prior claim
 * admitted stays admitted when this stream has no geometry of its own to claim with.
 */
export function chainInputGeometryClaim(
  runtime: Partial<Pick<OrcaRuntimeService, 'claimRemoteDesktopViewerForInput'>>,
  ptyId: string,
  subscriptionKey: string,
  priorClaimTail: Promise<boolean>
): Promise<boolean> {
  const claimForInput = async (priorClaimed: boolean): Promise<boolean> => {
    let claimed = false
    try {
      claimed = (await runtime.claimRemoteDesktopViewerForInput?.(ptyId, subscriptionKey)) ?? false
    } catch {
      // Why: a failed geometry claim must never swallow the keystroke queued behind it.
    }
    return claimed || priorClaimed
  }
  return priorClaimTail.then(claimForInput, () => claimForInput(false))
}
