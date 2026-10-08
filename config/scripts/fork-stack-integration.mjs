// Builds the integration commit: upstream main plus a merge of every re-stacked topic, in
// manifest order, with rerere primed from the integration main last adopted.
import { settleConflicts } from './fork-stack-conflict-settling.mjs'
import { PICK_CONFIG, cleanCheckout } from './fork-stack-git.mjs'

const LEARN_MERGE_LIMIT = 50

export function learnMergeResolutions({ git, integrationSha, upstreamSha }) {
  const merges = git
    .text([
      'rev-list',
      '--first-parent',
      '--merges',
      `--max-count=${LEARN_MERGE_LIMIT}`,
      integrationSha,
      `^${upstreamSha}`
    ])
    .split('\n')
    .filter(Boolean)
  let learned = 0
  for (const merge of merges) {
    const parents = git.text(['rev-list', '--parents', '-n', '1', merge]).split(' ').slice(1)
    if (parents.length !== 2) {
      continue
    }
    git.run(['checkout', '--quiet', '--detach', parents[0]])
    const attempt = git.run(
      ['-c', 'rerere.enabled=true', 'merge', '--no-commit', '--no-ff', parents[1]],
      { allowFailure: true }
    )
    if (attempt.code !== 0 && git.text(['ls-files', '-u']).length > 0) {
      git.run(['checkout', merge, '--', '.'])
      git.run(['-c', 'rerere.enabled=true', 'rerere'])
      learned += 1
    }
    cleanCheckout(git)
  }
  return learned
}

/** The last integration main adopted: the second parent of a main-update commit. */
export function previousIntegration(git, mainSha) {
  // A GitHub merge-button commit wraps the main-update commit once more; follow both layers.
  let candidate = null
  let commit = mainSha
  for (let depth = 0; depth < 2; depth += 1) {
    const parents = git.text(['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1)
    const tree = git.text(['rev-parse', `${commit}^{tree}`])
    if (parents.length !== 2 || tree !== git.text(['rev-parse', `${parents[1]}^{tree}`])) {
      break
    }
    candidate = parents[1]
    commit = parents[1]
  }
  return candidate
}

export function mergeStacks({ git, upstreamSha, topics, integrationBranch }) {
  git.run(['checkout', '--quiet', '--detach', upstreamSha])
  const rerere = []
  for (const topic of topics) {
    if (git.ok(['merge-base', '--is-ancestor', topic.newTip, 'HEAD'])) {
      continue
    }
    const merge = git.run(
      [
        ...PICK_CONFIG,
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        `Merge ${topic.newRef ?? topic.previousRef} into ${integrationBranch}`,
        topic.newTip
      ],
      { allowFailure: true }
    )
    if (merge.code === 0) {
      continue
    }
    const settled = settleConflicts(git, `${merge.stdout}\n${merge.stderr}`, {
      topicRevision: topic.newTip,
      regenerateXterm: false
    })
    if (settled.blocked) {
      cleanCheckout(git)
      return {
        status: 'conflict',
        rerere,
        conflict: { topic: topic.name, files: settled.files, error: settled.error }
      }
    }
    git.run(['commit', '--quiet', '--no-verify', '--no-edit'])
    rerere.push({ topic: topic.name, paths: settled.rerere })
  }
  return { status: 'built', rerere }
}
