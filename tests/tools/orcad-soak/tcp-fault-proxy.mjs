// A TCP proxy that sits between a client and orcad and injects network faults, so soak runs
// need no toxiproxy. Modes apply to live and new connections alike:
//   pass       forward bytes unchanged
//   latency    delay every chunk by latencyMs ± jitterMs, preserving order per direction
//   partition  hold every byte (no FIN, no RST) until healed, like a routed-away link whose
//              TCP retransmits eventually succeed; bytes are delivered in order on heal
//   reset      RST every live connection and every new one
import net from 'node:net'

export class TcpFaultProxy {
  constructor({ targetHost = '127.0.0.1', targetPort, listenHost = '127.0.0.1', listenPort = 0 }) {
    this.target = { host: targetHost, port: targetPort }
    this.listen = { host: listenHost, port: listenPort }
    this.mode = { kind: 'pass', latencyMs: 0, jitterMs: 0 }
    this.pairs = new Set()
    this.stats = { accepted: 0, reset: 0, bytesUp: 0, bytesDown: 0, heldChunks: 0 }
    this.server = net.createServer((client) => this.accept(client))
  }

  async start() {
    await new Promise((resolvePromise, rejectPromise) => {
      this.server.once('error', rejectPromise)
      this.server.listen(this.listen.port, this.listen.host, () => resolvePromise())
    })
    this.port = this.server.address().port
    return this.port
  }

  retarget(targetPort) {
    this.target.port = targetPort
  }

  setMode(mode) {
    const previous = this.mode.kind
    this.mode = { latencyMs: 0, jitterMs: 0, ...mode }
    if (this.mode.kind === 'reset') {
      for (const pair of this.pairs) {
        this.resetPair(pair)
      }
    } else if (previous === 'partition' && this.mode.kind !== 'partition') {
      for (const pair of this.pairs) {
        pair.up.flush()
        pair.down.flush()
      }
    }
  }

  accept(client) {
    this.stats.accepted += 1
    if (this.mode.kind === 'reset') {
      this.stats.reset += 1
      client.resetAndDestroy()
      return
    }
    const upstream = net.connect(this.target.port, this.target.host)
    const pair = { client, upstream }
    pair.up = this.channel(upstream, 'bytesUp')
    pair.down = this.channel(client, 'bytesDown')
    this.pairs.add(pair)
    client.on('data', (chunk) => pair.up.push(chunk))
    upstream.on('data', (chunk) => pair.down.push(chunk))
    const close = () => {
      if (!this.pairs.delete(pair)) {
        return
      }
      client.destroy()
      upstream.destroy()
    }
    // Half-close is forwarded only once held bytes are out, so ordering survives a partition.
    client.on('end', () => pair.up.end())
    upstream.on('end', () => pair.down.end())
    for (const socket of [client, upstream]) {
      socket.on('error', close)
      socket.on('close', close)
    }
  }

  channel(destination, counter) {
    const held = []
    let pendingEnd = false
    let lastDue = 0
    const deliver = (chunk) => {
      this.stats[counter] += chunk.length
      if (!destination.destroyed) {
        destination.write(chunk)
      }
    }
    const channel = {
      push: (chunk) => {
        if (this.mode.kind === 'partition' || held.length > 0) {
          held.push(chunk)
          this.stats.heldChunks += 1
          if (this.mode.kind !== 'partition') {
            channel.flush()
          }
          return
        }
        if (this.mode.kind === 'latency') {
          const jitter = (Math.random() * 2 - 1) * this.mode.jitterMs
          // Never schedule before the previous chunk: TCP delivers in order.
          const due = Math.max(lastDue, Date.now() + this.mode.latencyMs + jitter)
          lastDue = due
          setTimeout(() => deliver(chunk), Math.max(0, due - Date.now()))
          return
        }
        deliver(chunk)
      },
      flush: () => {
        while (held.length > 0 && this.mode.kind !== 'partition') {
          deliver(held.shift())
        }
        if (pendingEnd && held.length === 0) {
          destination.end()
        }
      },
      end: () => {
        pendingEnd = true
        if (held.length === 0 && this.mode.kind !== 'partition') {
          const wait = Math.max(0, lastDue - Date.now())
          setTimeout(() => destination.end(), wait)
        }
      }
    }
    return channel
  }

  resetPair(pair) {
    this.stats.reset += 1
    this.pairs.delete(pair)
    pair.client.resetAndDestroy()
    pair.upstream.resetAndDestroy()
  }

  get liveConnections() {
    return this.pairs.size
  }

  async close() {
    for (const pair of this.pairs) {
      pair.client.destroy()
      pair.upstream.destroy()
    }
    this.pairs.clear()
    await new Promise((resolvePromise) => this.server.close(() => resolvePromise()))
  }
}
