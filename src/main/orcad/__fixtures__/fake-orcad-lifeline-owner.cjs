/**
 * Stands in for orcad as the lifeline's owner: spawns the watcher from the spec the
 * test built (ORCAD_LIFELINE_SPEC, JSON), holds its stdin pipe, and idles until killed.
 * Prints `{ watcherPid }` once the watcher is running.
 */
'use strict'

const { spawn } = require('node:child_process')

const spec = JSON.parse(process.env.ORCAD_LIFELINE_SPEC ?? '{}')
const watcher = spawn(spec.program, spec.args, {
  env: spec.env,
  detached: true,
  stdio: ['pipe', 'ignore', 'ignore']
})
watcher.stdin.on('error', () => undefined)
process.stdout.write(`${JSON.stringify({ watcherPid: watcher.pid })}\n`)
setInterval(() => undefined, 1_000)
