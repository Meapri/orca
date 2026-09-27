import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveBaselineReleaseRef } from './release-checkout'
import {
  RESUME_JOURNEY_TEXT,
  expectedResumeJourneyView,
  runTerminalResumeJourney,
  type ResumeJourneyRecord
} from './terminal-resume-journey'
import {
  loadTerminalWireBuild,
  WORKING_TREE,
  type TerminalWireBuild
} from './versioned-terminal-wire'

// Why: a cold CI run extracts the baseline checkout before the first journey.
const SUITE_TIMEOUT_MS = 180_000

let baselineRef: string
let current: TerminalWireBuild
let baseline: TerminalWireBuild
let currentReference: ResumeJourneyRecord
let baselineReference: ResumeJourneyRecord

beforeAll(async () => {
  baselineRef = resolveBaselineReleaseRef()
  ;[current, baseline] = await Promise.all([
    loadTerminalWireBuild(WORKING_TREE),
    loadTerminalWireBuild(baselineRef)
  ])
  currentReference = await runTerminalResumeJourney({ hostBuild: current, clientBuild: current })
  baselineReference = await runTerminalResumeJourney({ hostBuild: baseline, clientBuild: baseline })
}, SUITE_TIMEOUT_MS)

afterEach(() => {
  expect(typeof globalThis.window).toBe('undefined')
})

function expectPaneMatchesHost(record: ResumeJourneyRecord): void {
  // Whatever the pairing negotiated, the pane ends showing exactly the host's buffer, once.
  expect(record.view).toBe(expectedResumeJourneyView())
  expect(record.rejected).toEqual([])
  expect(record.clientErrors).toEqual([])
}

function reconnectCapabilities(record: ResumeJourneyRecord): Record<string, unknown> {
  const capabilities = record.reconnectSubscribed?.capabilities
  return typeof capabilities === 'object' && capabilities !== null ? { ...capabilities } : {}
}

describe('cross-version terminal stream resumption', () => {
  it('current client against current server replays only the missed tail', () => {
    expectPaneMatchesHost(currentReference)
    expect(currentReference.resumePoint).toEqual({
      token: expect.any(String),
      seq: expect.any(Number)
    })
    expect(currentReference.resumed).toBe(true)
    expect(currentReference.snapshotStartsAfterReconnect).toBe(0)
    expect(currentReference.reconnectSubscribed).toMatchObject({
      capabilities: { outputResume: 1 },
      resumed: { fromSeq: currentReference.resumePoint?.seq }
    })
    // The whole point: the reconnect carries the missed bytes, not the scrollback again.
    expect(currentReference.hostToClientBytesAfterReconnect).toBeLessThan(
      RESUME_JOURNEY_TEXT.initialBuffer.length / 10
    )
  })

  it('old client against old server is the snapshot reference', () => {
    expectPaneMatchesHost(baselineReference)
    expect(baselineReference.resumed).toBe(false)
    expect(baselineReference.snapshotStartsAfterReconnect).toBe(1)
  })

  it(
    'new client against old server falls back to the full snapshot',
    async () => {
      const record = await runTerminalResumeJourney({ hostBuild: baseline, clientBuild: current })
      expectPaneMatchesHost(record)
      // The new client only holds a resume point when the host echoed the capability.
      const hostNegotiates = reconnectCapabilities(baselineReference).outputResume === 1
      expect(record.resumePoint !== null).toBe(hostNegotiates)
      if (!hostNegotiates) {
        expect(record.resumed).toBe(false)
        expect(record.snapshotStartsAfterReconnect).toBe(1)
      }
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'old client against new server is served the snapshot it always was',
    async () => {
      const record = await runTerminalResumeJourney({ hostBuild: current, clientBuild: baseline })
      expectPaneMatchesHost(record)
      const clientNegotiates = baselineReference.resumePoint !== null
      if (!clientNegotiates) {
        expect(reconnectCapabilities(record)).not.toHaveProperty('outputResume')
        expect(record.reconnectSubscribed).not.toHaveProperty('resumed')
        expect(record.snapshotStartsAfterReconnect).toBe(1)
      }
    },
    SUITE_TIMEOUT_MS
  )
})
