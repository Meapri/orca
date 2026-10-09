import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeSubscribe,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitOutput,
  emitSnapshot,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

function subscribeFrameCount(): number {
  return subscriptionSendBinary.mock.calls
    .map((call) => decodeTerminalStreamFrame(call[0]))
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe).length
}

function respondSubscribed(streamId: number, extra: Record<string, unknown> = {}): void {
  subscriptionCallbacks?.onResponse({
    ok: true,
    result: {
      type: 'subscribed',
      streamId,
      capabilities: { outputResume: 1 },
      resumeToken: 'run-1',
      ...extra
    }
  })
}

async function connectWithAppliedOutput() {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const onReplayData = vi.fn()
  const onData = vi.fn()
  const onConnect = vi.fn()
  const onStreamRecovered = vi.fn()
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  await transport.connect({
    url: '',
    callbacks: { onData, onReplayData, onConnect, onStreamRecovered }
  })
  await vi.waitFor(() => expect(subscribeFrameCount()).toBe(1))
  const firstStreamId = latestSubscribePayload().streamId
  respondSubscribed(firstStreamId)
  emitSnapshot(firstStreamId, 'INITIAL_SNAPSHOT')
  await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
  emitOutput(firstStreamId, 'SEEN', 24)
  return { transport, onReplayData, onData, onConnect, onStreamRecovered }
}

describe('remote runtime PTY transport stream resumption', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('presents the last applied output position on reconnect and keeps the pane contents', async () => {
    const { transport, onReplayData, onData, onConnect, onStreamRecovered } =
      await connectWithAppliedOutput()

    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    const reconnect = latestSubscribePayload()
    expect(reconnect.resume).toEqual({ token: 'run-1', seq: 24 })

    respondSubscribed(reconnect.streamId, { resumed: { fromSeq: 24 } })
    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2))
    emitOutput(reconnect.streamId, 'MISSED', 30)

    // No second snapshot replay, no retained-buffer restore: the pane already holds it all.
    expect(onReplayData.mock.calls.map((call) => call[0])).toEqual(['INITIAL_SNAPSHOT'])
    expect(onStreamRecovered).not.toHaveBeenCalled()
    expect(onData.mock.calls.map((call) => call[0])).toEqual(['SEEN', 'MISSED'])
    transport.destroy?.()
  })

  it('replays the host snapshot when the host declines to resume', async () => {
    const { transport, onReplayData, onConnect } = await connectWithAppliedOutput()

    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    const reconnectStreamId = latestSubscribePayload().streamId
    respondSubscribed(reconnectStreamId, { resumeToken: 'run-2' })
    emitSnapshot(reconnectStreamId, 'RECONNECT_SNAPSHOT')

    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2))
    expect(onReplayData.mock.calls.map((call) => call[0])).toEqual([
      'INITIAL_SNAPSHOT',
      'RECONNECT_SNAPSHOT'
    ])
    transport.destroy?.()
  })

  it('asks for a snapshot, not a resume, when output was paused at the drop', async () => {
    const { transport } = await connectWithAppliedOutput()
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'subscribed',
        streamId: latestSubscribePayload().streamId,
        capabilities: { outputPause: 1, outputResume: 1 },
        resumeToken: 'run-1'
      }
    })
    transport.setOutputPaused?.(true)

    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    expect(latestSubscribePayload()).not.toHaveProperty('resume')
    transport.destroy?.()
  })
})
