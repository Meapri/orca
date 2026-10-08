import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/orcad-release.yml', 'utf8'))
const { build, publish } = workflow.jobs

describe('orcad release workflow', () => {
  it('publishes only for pushed orcad-v* tags, an explicit dispatch, or a release caller', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_call', 'workflow_dispatch'])
    expect(workflow.on.workflow_call.inputs.tag).toMatchObject({ required: true, type: 'string' })
    expect(workflow.on.push).toEqual({ tags: ['orcad-v*'] })
    expect(workflow.on.push.branches).toBeUndefined()
  })

  it('builds both Linux architectures as required legs and macOS as optional', () => {
    const legs = build.strategy.matrix.include
    expect(legs.filter((leg) => !leg.optional).map((leg) => leg.target)).toEqual([
      'linux-x64-glibc',
      'linux-arm64-glibc'
    ])
    expect(legs.find((leg) => leg.target === 'darwin-arm64')?.optional).toBe(true)
    expect(build['continue-on-error']).toBe('${{ matrix.optional }}')
  })

  it('packs stable asset names, gated by the glibc floor, and writes only from publish', () => {
    const runs = build.steps.map((step) => step.run ?? '').join('\n')
    expect(runs).toContain('verifyLinuxGlibcFloor')
    expect(runs).toContain('--asset-names stable')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(build.permissions).toBeUndefined()
    expect(publish.permissions).toEqual({ contents: 'write' })
    expect(publish.needs).toBe('build')
  })

  it('verifies checksums before publishing and never marks the release latest', () => {
    const names = publish.steps.map((step) => step.name ?? step.uses)
    const verify = names.indexOf('Verify every asset against its checksum')
    const release = names.indexOf('Create or update the GitHub Release')
    expect(verify).toBeGreaterThan(0)
    expect(verify).toBeLessThan(release)
    expect(publish.steps[release].run).toContain('--latest=false')
    expect(publish.steps[release].run).toContain('--verify-tag')
  })

  it('keeps expressions out of every shell script', () => {
    for (const step of [...build.steps, ...publish.steps]) {
      expect(step.run ?? '').not.toContain('${{')
    }
    expect(build.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with).toEqual(
      expect.objectContaining({ 'persist-credentials': false })
    )
  })
})
