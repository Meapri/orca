import { describe, expect, it } from 'vitest'
import { latestBeat, processAlive, slopePerMinute } from './orcad-soak-host.mjs'

describe('orcad soak host primitives', () => {
  it('fits growth per minute and refuses to fit too few points', () => {
    const points = [0, 1, 2, 3].map((minute) => ({ t: minute * 60_000, value: 10 + 5 * minute }))
    expect(slopePerMinute(points)).toBeCloseTo(5)
    expect(slopePerMinute(points.map((point) => ({ ...point, value: 7 })))).toBe(0)
    expect(slopePerMinute(points.slice(0, 2))).toBeNull()
    expect(slopePerMinute([...points.slice(0, 2), { t: 1, value: Number.NaN }])).toBeNull()
  })

  it('reads the highest heartbeat from a terminal tail, or null without one', () => {
    const read = {
      result: { terminal: { tail: ['SOAK_BEAT 3', 'noise', 'SOAK_BEAT 9', 'SOAK_BEAT 8'] } }
    }
    expect(latestBeat(read)).toBe(9)
    expect(latestBeat({ result: { terminal: { tail: ['prompt %'] } } })).toBeNull()
    expect(latestBeat(null)).toBeNull()
  })

  it('treats only a running PID as alive', () => {
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(2 ** 22 + 12_345)).toBe(false)
    expect(processAlive(1)).toBe(false)
    expect(processAlive(Number.NaN)).toBe(false)
  })
})
