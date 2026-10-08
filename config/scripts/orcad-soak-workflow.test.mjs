import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/orcad-soak.yml', 'utf8'))
const job = workflow.jobs.soak

describe('orcad soak workflow', () => {
  it('runs only on demand, never as a pull-request or push gate', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(workflow.on.pull_request).toBeUndefined()
    expect(workflow.on.push).toBeUndefined()
    expect(workflow.on.schedule).toBeUndefined()
  })

  it('gives the daemon a real user manager before anything boots orcad', () => {
    const names = job.steps.map((step) => step.name ?? step.run ?? step.uses)
    const linger = names.indexOf('Start a lingering user manager')
    expect(linger).toBeGreaterThan(0)
    expect(job.steps[linger].run).toContain('loginctl enable-linger')
    expect(linger).toBeLessThan(
      names.indexOf('Installer lifecycle and unit restart under live terminals')
    )
    expect(linger).toBeLessThan(names.indexOf('Fault injection and soak'))
  })

  it('keeps inputs out of the shell and always uploads the reports', () => {
    for (const step of job.steps) {
      expect(step.run ?? '').not.toContain('${{')
    }
    const upload = job.steps.at(-1)
    expect(upload.uses).toMatch(/^actions\/upload-artifact@/)
    expect(upload.if).toBe('always()')
    expect(job.steps[0].with['persist-credentials']).toBe(false)
  })
})
