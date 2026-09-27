import { expect, vi } from 'vitest'
import { createHostTerminalRuntimeStub } from './host-terminal-runtime-stub'
import { createTerminalWireLink, type RejectedFrame } from './terminal-wire-link'
import type { TerminalResumePoint, TerminalWireBuild } from './versioned-terminal-wire'

const TERMINAL_HANDLE = 'terminal-resume-journey'
const BARRIER_TIMEOUT_MS = 10_000

export const RESUME_JOURNEY_TEXT = {
  // Large enough that a full snapshot visibly costs more than the missed tail.
  initialBuffer: `${'scrollback line\r\n'.repeat(2_000)}`,
  beforeDrop: 'seen before the drop\r\n',
  missed: 'produced while disconnected\r\n',
  afterReconnect: 'live after reconnect\r\n'
}

export type ResumeJourneyRecord = {
  hostLabel: string
  clientLabel: string
  /** What the pane shows: snapshots replace it, output appends to it. */
  view: string
  resumePoint: TerminalResumePoint | null
  resumed: boolean
  snapshotStartsAfterReconnect: number
  hostToClientBytesAfterReconnect: number
  reconnectSubscribed: Record<string, unknown> | null
  rejected: RejectedFrame[]
  clientErrors: string[]
}

/**
 * subscribe -> live output -> drop -> output nobody sees -> resubscribe presenting whatever
 * resume point the client build produced -> live output. Every pairing must end with the pane
 * showing exactly the host's buffer; only the cost of getting there may differ.
 */
export async function runTerminalResumeJourney(args: {
  hostBuild: TerminalWireBuild
  clientBuild: TerminalWireBuild
}): Promise<ResumeJourneyRecord> {
  const { hostBuild, clientBuild } = args
  const hostStub = createHostTerminalRuntimeStub({
    terminalHandle: TERMINAL_HANDLE,
    initialBuffer: RESUME_JOURNEY_TEXT.initialBuffer
  })
  const link = createTerminalWireLink({ hostBuild, clientBuild, hostStub })
  const record: ResumeJourneyRecord = {
    hostLabel: hostBuild.label,
    clientLabel: clientBuild.label,
    view: '',
    resumePoint: null,
    resumed: false,
    snapshotStartsAfterReconnect: 0,
    hostToClientBytesAfterReconnect: 0,
    reconnectSubscribed: null,
    rejected: link.rejected,
    clientErrors: []
  }
  let subscribedCount = 0
  let transportCloses = 0
  const barrier = async (detail: string, predicate: () => boolean): Promise<void> => {
    await vi
      .waitFor(() => expect(predicate()).toBe(true), { timeout: BARRIER_TIMEOUT_MS, interval: 5 })
      .catch(() => {
        throw new Error(`Resume journey stalled: ${detail}`)
      })
  }
  const subscribe = (resumeFrom?: TerminalResumePoint) =>
    clientBuild.client.getRemoteRuntimeTerminalMultiplexer('resume-runtime').subscribeTerminal({
      terminal: TERMINAL_HANDLE,
      client: { id: 'resume-client', type: 'desktop' },
      viewport: { cols: 120, rows: 40 },
      ...(resumeFrom ? { resumeFrom } : {}),
      callbacks: {
        onData: (data) => {
          record.view += data
        },
        onSnapshot: (data) => {
          record.view = data
        },
        onSubscribed: (info) => {
          subscribedCount++
          record.resumed ||= info?.resumed === true
        },
        onError: (message) => record.clientErrors.push(message),
        onTransportClose: (event) => {
          transportCloses++
          record.resumePoint = event.resumePoint ?? null
        }
      }
    })

  try {
    await subscribe()
    await barrier('first subscribe', () => subscribedCount >= 1)
    hostStub.emitOutput(RESUME_JOURNEY_TEXT.beforeDrop)
    await barrier('live output before drop', () =>
      record.view.endsWith(RESUME_JOURNEY_TEXT.beforeDrop)
    )

    link.disconnect()
    await barrier('transport close', () => transportCloses >= 1)
    hostStub.emitOutput(RESUME_JOURNEY_TEXT.missed)

    const observedBeforeReconnect = link.observed.length
    const connectionsBeforeReconnect = link.connections.length
    const terminal = await subscribe(record.resumePoint ?? undefined)
    await barrier('resubscribe', () => subscribedCount >= 2)
    await barrier('missed output reaches the pane', () =>
      record.view.includes(RESUME_JOURNEY_TEXT.missed)
    )
    hostStub.emitOutput(RESUME_JOURNEY_TEXT.afterReconnect)
    await barrier('live output after reconnect', () =>
      record.view.endsWith(RESUME_JOURNEY_TEXT.afterReconnect)
    )
    const afterReconnect = link.observed.slice(observedBeforeReconnect)
    const snapshotStart = Number(clientBuild.codec.TerminalStreamOpcode.SnapshotStart)
    record.snapshotStartsAfterReconnect = afterReconnect.filter(
      (frame) => frame.direction === 'host-to-client' && frame.opcode === snapshotStart
    ).length
    record.hostToClientBytesAfterReconnect = afterReconnect
      .filter((frame) => frame.direction === 'host-to-client')
      .reduce((total, frame) => total + frame.text.length, 0)
    record.reconnectSubscribed =
      link.connections
        .slice(connectionsBeforeReconnect)
        .flatMap((connection) => connection.events)
        .find((event) => event.type === 'subscribed') ?? null
    terminal.close()
  } finally {
    await link.dispose()
  }
  return record
}

export function expectedResumeJourneyView(): string {
  return (
    RESUME_JOURNEY_TEXT.initialBuffer +
    RESUME_JOURNEY_TEXT.beforeDrop +
    RESUME_JOURNEY_TEXT.missed +
    RESUME_JOURNEY_TEXT.afterReconnect
  )
}
