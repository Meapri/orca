// Pure decisions for re-stacking one topic onto a new base: which commits upstream already has,
// and how to read git's output about them. Git and gh I/O live in fork-stack-sync.mjs.

/** `git cherry <upstream> <head> <limit>` output: `-` marks a patch-id match in upstream. */
export function parseCherryOutput(text) {
  const marks = new Map()
  for (const line of text.split('\n')) {
    const match = /^([+-]) ([0-9a-f]{40})\b/.exec(line.trim())
    if (match) {
      marks.set(match[2], match[1] === '-' ? 'equivalent' : 'unique')
    }
  }
  return marks
}

/** Records written by `git log --format=%H%x1f%s%x1f%B%x1e`. */
export function parseCommitRecords(text) {
  return text
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha, subject, message = ''] = record.split('\x1f')
      return { sha: sha.trim(), subject, message: message.trimEnd() }
    })
}

/** The trailer block: the last paragraph, when every line in it is `Key: value`. */
export function trailerLines(message) {
  const paragraphs = message.trimEnd().split(/\n[ \t]*\n/)
  if (paragraphs.length < 2) {
    return []
  }
  const lines = paragraphs.at(-1).split('\n')
  return lines.every((line) => /^[A-Za-z][\w-]*:\s/.test(line) || /^\s/.test(line)) ? lines : []
}

/**
 * Upstream PR numbers from `Upstream-PR:` trailers naming `repository`, either as
 * `owner/repo#123` or as a pull request URL. Other repositories are ignored.
 */
export function upstreamPrNumbers(message, repository) {
  const wanted = repository.toLowerCase()
  const numbers = []
  for (const line of trailerLines(message)) {
    const match = /^upstream-pr:\s*(.+?)\s*$/i.exec(line)
    if (!match) {
      continue
    }
    const value = match[1]
    const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(value)
    const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(value)
    const found = short ?? url
    if (found && found[1].toLowerCase() === wanted) {
      numbers.push(Number(found[2]))
    }
  }
  return numbers
}

/** One GraphQL request for every PR, so a daily sync costs a single API call. */
export function upstreamPrQuery(repository, numbers) {
  const [owner, name] = repository.split('/')
  const fields = [...new Set(numbers)]
    .sort((left, right) => left - right)
    .map(
      (number) =>
        `pr${number}: pullRequest(number: ${number}) { number url merged baseRefName mergeCommit { oid } }`
    )
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields.join(' ')} } }`
}

/** GraphQL response to `{ [number]: { merged, baseRef, mergeCommit, url } }`; missing PRs are absent. */
export function parseUpstreamPrStates(response) {
  const repository = response?.data?.repository ?? {}
  const states = {}
  for (const pull of Object.values(repository)) {
    if (pull && typeof pull.number === 'number') {
      states[pull.number] = {
        merged: pull.merged === true,
        baseRef: pull.baseRefName ?? null,
        mergeCommit: pull.mergeCommit?.oid ?? null,
        url: pull.url ?? null
      }
    }
  }
  return states
}

/** Source commits named by `git cherry-pick -x` lines in a message. */
export function cherryPickSources(message) {
  return [...message.matchAll(/^\(cherry picked from commit ([0-9a-f]{40})\)$/gm)].map(
    (match) => match[1]
  )
}

/**
 * Decides, per commit, whether to cherry-pick it or drop it because upstream accepted it:
 * - its `Upstream-PR:` merged into the upstream branch and the merge commit is in the new
 *   upstream (`inUpstream`, checked with git by the caller);
 * - its `cherry picked from` source commit is now in upstream (`upstreamSources`);
 * - `git cherry` found the same patch in upstream.
 * Commits that turn empty when picked are dropped later, by the picker.
 */
export function planTopicCommits({
  commits,
  cherry,
  prStates,
  repository,
  upstreamBranch,
  upstreamSources = new Set()
}) {
  return commits.map((commit) => {
    const prs = upstreamPrNumbers(commit.message, repository)
    const accepted = prs.find((number) => {
      const state = prStates?.[number]
      return state?.merged && state.baseRef === upstreamBranch && state.inUpstream
    })
    const samePatch = cherry.get(commit.sha) === 'equivalent'
    const base = { sha: commit.sha, subject: commit.subject, prs }
    if (accepted !== undefined) {
      return {
        ...base,
        action: 'drop',
        reason: 'upstream-accepted',
        pr: accepted,
        prUrl: prStates[accepted].url,
        samePatch
      }
    }
    const source = cherryPickSources(commit.message).find((sha) => upstreamSources.has(sha))
    if (source) {
      return { ...base, action: 'drop', reason: 'upstream-commit', upstreamCommit: source }
    }
    if (samePatch) {
      return { ...base, action: 'drop', reason: 'patch-equivalent' }
    }
    return { ...base, action: 'pick' }
  })
}

/** Paths rerere settled from a recorded resolution, from cherry-pick or merge output. */
export function rerereResolvedPaths(output) {
  const paths = new Set()
  for (const match of output.matchAll(
    /^(?:Resolved|Staged) '(.+)' using previous resolution\.$/gm
  )) {
    paths.add(match[1])
  }
  return [...paths].sort()
}

/** `git ls-files -u -z` output to a map of path -> sorted stage numbers. */
export function parseUnmergedStages(output) {
  const stages = new Map()
  for (const record of output.split('\0').filter(Boolean)) {
    const match = /^\d+ [0-9a-f]+ ([123])\t(.+)$/s.exec(record)
    if (!match) {
      throw new Error(`Unrecognised git ls-files -u record: ${JSON.stringify(record)}`)
    }
    const [, stage, filePath] = match
    stages.set(filePath, [...(stages.get(filePath) ?? []), Number(stage)].sort())
  }
  return stages
}

/**
 * Stage 2 is the side being built on, stage 3 the topic commit being applied
 * (cherry-pick) or the stack being merged (integration).
 */
export function conflictKind(stages) {
  const key = stages.join('')
  const kinds = {
    123: 'both modified',
    23: 'both added',
    12: 'deleted by topic',
    13: 'deleted on the new base',
    2: 'added on the new base only',
    3: 'added by topic only'
  }
  return kinds[key] ?? `stages ${key}`
}

export function commitTreeArgs({ tree, mainSha, integrationSha }) {
  return ['commit-tree', tree, '-p', mainSha, '-p', integrationSha, '-F', '-']
}

export function mainUpdateMessage({ key, integrationBranch, upstreamSha, topics }) {
  const lines = [
    `chore(fork): update main to ${integrationBranch}`,
    '',
    `Tree is exactly ${integrationBranch}: upstream main ${upstreamSha.slice(0, 12)} plus the`,
    `fork's topic stacks (sync ${key}). The first parent keeps main's history; the second is`,
    'the integration branch, so merging this fast-forwards main without a force-push.',
    '',
    ...topics.map((topic) => `- ${topic.name}: ${topic.newRef ?? topic.previousRef}`)
  ]
  return `${lines.join('\n')}\n`
}
