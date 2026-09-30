import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/distribution-release.yml', 'utf8'))
const { prepare, mac, orcad, publish } = workflow.jobs
const allSteps = [...prepare.steps, ...mac.steps, ...publish.steps]

describe('distribution release workflow', () => {
  it('runs for version tags and explicit dispatches only', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on.push).toEqual({ tags: ['v[0-9]*'] })
    expect(workflow.on.workflow_dispatch.inputs.dry_run.type).toBe('boolean')
  })

  // Why: a merged-upstream copy must never publish from, or into, the official repository.
  it('refuses to run outside the repository app-distribution.json names', () => {
    const guard = prepare.steps.find((step) =>
      step.name?.startsWith('Refuse to run outside the distribution')
    )
    expect(guard.run).toContain('app-distribution.json')
    expect(guard.run).toContain('GITHUB_REPOSITORY')
  })

  it('packages an ad-hoc signed arm64 build without Apple credentials', () => {
    const runs = mac.steps.map((step) => step.run ?? '').join('\n')
    expect(runs).toContain('package-mac-adhoc.mjs --arch arm64')
    expect(JSON.stringify(mac)).not.toMatch(/CSC_LINK|APPLE_ID|ORCA_MAC_RELEASE/)
    expect(runs).toContain('latest-mac.yml')
    expect(runs).toContain('SHA256SUMS')
  })

  it('reuses the orcad release workflow for the matching orcad tag', () => {
    expect(orcad.uses).toBe('./.github/workflows/orcad-release.yml')
    expect(orcad.with.tag).toBe('${{ needs.prepare.outputs.orcad_tag }}')
    expect(orcad.permissions).toEqual({ contents: 'write' })
  })

  it('verifies checksums and publishes from a draft only after every asset is uploaded', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(mac.permissions).toBeUndefined()
    expect(publish.needs).toEqual(['prepare', 'mac'])
    const names = publish.steps.map((step) => step.name ?? step.uses)
    expect(names.indexOf('Verify every asset against SHA256SUMS')).toBeLessThan(
      names.findIndex((name) => name.startsWith('Upload assets to a draft release'))
    )
    const release = publish.steps.at(-1).run
    expect(release).toContain('--draft')
    expect(release.indexOf('gh release upload')).toBeLessThan(release.indexOf('--draft=false'))
  })

  it('keeps expressions out of every shell script and credentials out of checkouts', () => {
    for (const step of allSteps) {
      expect(step.run ?? '').not.toContain('${{')
    }
    for (const step of allSteps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
      expect(step.with).toEqual(expect.objectContaining({ 'persist-credentials': false }))
    }
  })
})
