/**
 * Methods whose replies may be deflated before E2EE encryption.
 *
 * Compression leaks through ciphertext length when attacker-influenced text shares a compression
 * context with a secret (CRIME/BREACH). Each frame is its own context, so the question is only
 * what one reply mixes. Every reply here is names, paths, refs and states — a repository's own
 * file and branch names may be attacker-chosen, but nothing beside them is a secret.
 *
 * Deliberately absent: terminal output and agent transcripts (typed secrets beside program
 * output), file and diff contents (a secret line beside an attacker-edited one), session tabs
 * (terminal titles carry command lines; browser URLs carry tokens beside page-chosen titles),
 * and anything touching accounts, pairing or credentials.
 */
export const COMPRESSIBLE_RUNTIME_RPC_METHODS: ReadonlySet<string> = new Set([
  'status.get',
  'repo.list',
  'worktree.list',
  'worktree.lineageList',
  'worktree.detectedList',
  'folderWorkspace.list',
  'git.status',
  'git.localBranches',
  'files.list',
  'files.listAll',
  'files.readDir',
  'files.searchPaths'
])
