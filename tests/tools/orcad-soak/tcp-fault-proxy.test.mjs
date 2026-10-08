import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TcpFaultProxy } from './tcp-fault-proxy.mjs'

function connect(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.connect(port, '127.0.0.1', () => resolvePromise(socket))
    socket.once('error', rejectPromise)
  })
}

function collect(socket) {
  const state = { text: '', closed: false, error: null }
  socket.on('data', (chunk) => {
    state.text += chunk.toString('utf8')
  })
  socket.on('close', () => {
    state.closed = true
  })
  socket.on('error', (error) => {
    state.error = error
  })
  return state
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time')
    }
    await sleep(10)
  }
}

describe('TcpFaultProxy', () => {
  let echo
  let proxy
  beforeEach(async () => {
    echo = net.createServer((socket) => socket.pipe(socket))
    await new Promise((resolvePromise) => echo.listen(0, '127.0.0.1', resolvePromise))
    proxy = new TcpFaultProxy({ targetPort: echo.address().port })
    await proxy.start()
  })
  afterEach(async () => {
    await proxy.close()
    await new Promise((resolvePromise) => echo.close(resolvePromise))
  })

  it('forwards bytes unchanged in pass mode', async () => {
    const socket = await connect(proxy.port)
    const received = collect(socket)
    socket.write('hello')
    await until(() => received.text === 'hello')
    socket.destroy()
  })

  it('delays both directions under latency while preserving order', async () => {
    proxy.setMode({ kind: 'latency', latencyMs: 80, jitterMs: 40 })
    const socket = await connect(proxy.port)
    const received = collect(socket)
    const started = Date.now()
    const expected = Array.from({ length: 20 }, (_, index) => `${index};`).join('')
    for (let index = 0; index < 20; index += 1) {
      socket.write(`${index};`)
    }
    await until(() => received.text.length === expected.length)
    expect(received.text).toBe(expected)
    expect(Date.now() - started).toBeGreaterThanOrEqual(80)
    socket.destroy()
  })

  it('holds bytes through a partition and delivers them in order on heal', async () => {
    const socket = await connect(proxy.port)
    const received = collect(socket)
    proxy.setMode({ kind: 'partition' })
    socket.write('during-')
    socket.write('partition')
    await sleep(250)
    expect(received.text).toBe('')
    expect(received.closed).toBe(false)
    proxy.setMode({ kind: 'pass' })
    await until(() => received.text === 'during-partition')
    socket.destroy()
  })

  it('resets live and new connections in reset mode', async () => {
    const live = await connect(proxy.port)
    const liveState = collect(live)
    proxy.setMode({ kind: 'reset' })
    await until(() => liveState.closed)
    expect(liveState.error?.code).toBe('ECONNRESET')
    const fresh = await connect(proxy.port).catch((error) => error)
    if (fresh instanceof net.Socket) {
      const freshState = collect(fresh)
      fresh.write('x')
      await until(() => freshState.closed)
      expect(freshState.text).toBe('')
    } else {
      expect(fresh.code).toBe('ECONNRESET')
    }
    expect(proxy.stats.reset).toBeGreaterThanOrEqual(2)
  })
})
