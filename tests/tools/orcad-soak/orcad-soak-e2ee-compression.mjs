// Measures compress-before-encrypt on a live orcad through the fault proxy: the same listing
// replies fetched by a client that advertises e2ee.text-deflate.v1 and by one that predates it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callRuntimeOnce, decodePairingUrl } from './orcad-soak-multiplex-client.mjs'

const UNTRACKED_FILES = 3_000
const DEFLATE_CAPABILITY = 'e2ee.text-deflate.v1'

export function createE2eeCompressionScenario({ ensureWorktree }) {
  return async function e2eeCompression(ctx, check) {
    await ensureWorktree(ctx)
    const dir = join(ctx.root, 'repo', 'generated', 'components')
    mkdirSync(dir, { recursive: true })
    for (let index = 0; index < UNTRACKED_FILES; index++) {
      writeFileSync(join(dir, `generated-component-${index}.tsx`), `export const n = ${index}\n`)
    }
    const pairing = decodePairingUrl(ctx.orcad.readiness.pairing.url)
    const endpoint = `ws://127.0.0.1:${ctx.proxy.port}`
    const worktree = `id:${ctx.worktreeId}`
    const calls = [
      { method: 'files.listAll', params: { worktree } },
      { method: 'git.status', params: { worktree } },
      { method: 'worktree.list', params: {} },
      // Never compressible, whatever the client advertises: the control for the policy.
      { method: 'terminal.list', params: {} }
    ]
    const results = []
    for (const call of calls) {
      const legacy = await callRuntimeOnce({ pairing, endpoint, ...call, clientCapabilities: [] })
      const current = await callRuntimeOnce({
        pairing,
        endpoint,
        ...call,
        clientCapabilities: [DEFLATE_CAPABILITY]
      })
      results.push({
        method: call.method,
        plaintextBytes: current.replyPlaintextBytes,
        legacyWireBytes: legacy.replyWireBytes,
        compressedWireBytes: current.replyWireBytes,
        compressed: current.compressed,
        savedPercent: Math.round((1 - current.replyWireBytes / legacy.replyWireBytes) * 100)
      })
      check(
        !legacy.compressed,
        `${call.method}: a client that never advertised got a compressed frame`
      )
      check(legacy.ok && current.ok, `${call.method}: a call failed`)
    }
    const listAll = results.find((result) => result.method === 'files.listAll')
    check(
      listAll?.compressed === true,
      'files.listAll was not compressed for an advertising client'
    )
    check(
      results.find((result) => result.method === 'terminal.list')?.compressed === false,
      'terminal.list was compressed although it is not on the policy list'
    )
    // The shipped CLI advertises the capability, so this proves its decoder reads the frames.
    const cli = await ctx.remote(['worktree', 'list'])
    check(
      cli.ok === true && (cli.result?.worktrees ?? []).length > 0,
      `the paired CLI could not read a compressed worktree.list: ${JSON.stringify(cli.error ?? null)}`
    )
    return { untrackedFiles: UNTRACKED_FILES, results }
  }
}
