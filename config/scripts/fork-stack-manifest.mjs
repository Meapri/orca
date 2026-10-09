// Pure model of config/fork-stacks.json, the fork's topic stacks in integration order, plus the
// branch names a sync publishes. Git I/O lives in fork-stack-sync.mjs.
// See docs/reference/fork-upstream-sync.md.

export const MANIFEST_PATH = 'config/fork-stacks.json'
export const MANIFEST_VERSION = 1
export const STACK_SYNC_PREFIX = 'stack-sync/'
export const INTEGRATION_PREFIX = 'integrate/fork-'
export const MAIN_UPDATE_PREFIX = 'main-update/fork-'

const TOPIC_NAME = /^[a-z0-9][a-z0-9-]*$/
const FULL_SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/
const SYNC_KEY = /^\d{4}-\d{2}-\d{2}(?:-(\d+))?$/
const ONTO = new Set(['upstream', 'integration'])

/** The subset of `git check-ref-format --branch` rules a manifest ref can break. */
export function branchNameProblem(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return 'is empty'
  }
  if (name.startsWith('refs/') || name.startsWith('origin/')) {
    return 'must be a bare branch name (no refs/ or origin/ prefix)'
  }
  if (
    /[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$|\.lock$|(?:^|\/)\./.test(name) ||
    // oxlint-disable-next-line no-control-regex -- git forbids control characters in ref names.
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    return 'is not a valid git branch name'
  }
  return null
}

/** Git cannot hold `a/b` and `a/b/c` as branches at once: one would be a file and a directory. */
export function refPrefixClash(names) {
  const sorted = [...names].sort()
  for (const name of sorted) {
    const parent = sorted.find((other) => other !== name && name.startsWith(`${other}/`))
    if (parent) {
      return [parent, name]
    }
  }
  return null
}

function topicProblems(topic, index) {
  const label = `topics[${index}]`
  if (!topic || typeof topic !== 'object' || Array.isArray(topic)) {
    return [`${label} must be an object`]
  }
  const problems = []
  if (!TOPIC_NAME.test(topic.name ?? '')) {
    problems.push(`${label}.name must match ${TOPIC_NAME}`)
  }
  const refProblem = branchNameProblem(topic.ref)
  if (refProblem) {
    problems.push(`${label}.ref ${refProblem}`)
  }
  if (!FULL_SHA.test(topic.base ?? '')) {
    problems.push(`${label}.base must be a full 40-character commit sha`)
  }
  if (topic.onto !== undefined && !ONTO.has(topic.onto)) {
    problems.push(`${label}.onto must be "upstream" or "integration"`)
  }
  const known = new Set(['name', 'ref', 'base', 'onto'])
  for (const key of Object.keys(topic)) {
    if (!known.has(key)) {
      problems.push(`${label} has unknown field "${key}"`)
    }
  }
  return problems
}

/** Parses and validates the manifest; throws one error listing every problem. */
export function parseManifest(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${MANIFEST_PATH} is not valid JSON: ${error.message}`)
  }
  const problems = []
  if (raw?.version !== MANIFEST_VERSION) {
    problems.push(`version must be ${MANIFEST_VERSION}`)
  }
  if (!REPOSITORY.test(raw?.upstream?.repository ?? '')) {
    problems.push('upstream.repository must be "<owner>/<repo>"')
  }
  if (branchNameProblem(raw?.upstream?.branch)) {
    problems.push('upstream.branch must be a branch name')
  }
  const topics = Array.isArray(raw?.topics) ? raw.topics : []
  if (topics.length === 0) {
    problems.push('topics must be a non-empty array')
  }
  topics.forEach((topic, index) => problems.push(...topicProblems(topic, index)))
  const names = topics.map((topic) => topic?.name)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate) {
    problems.push(`topic "${duplicate}" is listed twice`)
  }
  const refs = topics.map((topic) => topic?.ref).filter((ref) => typeof ref === 'string')
  const duplicateRef = refs.find((ref, index) => refs.indexOf(ref) !== index)
  if (duplicateRef) {
    problems.push(`ref "${duplicateRef}" is used by two topics`)
  }
  const clash = refPrefixClash(new Set(refs))
  if (clash) {
    problems.push(`refs "${clash[0]}" and "${clash[1]}" cannot both exist as git branches`)
  }
  const ontos = topics.map((topic) => topic?.onto ?? 'upstream')
  if (ontos[0] === 'integration') {
    problems.push('the first topic must build on upstream')
  }
  const firstIntegration = ontos.indexOf('integration')
  if (firstIntegration !== -1 && ontos.slice(firstIntegration).includes('upstream')) {
    problems.push('topics with onto "integration" must come after every upstream topic')
  }
  if (problems.length > 0) {
    throw new Error(`${MANIFEST_PATH} is invalid:\n- ${problems.join('\n- ')}`)
  }
  return {
    version: MANIFEST_VERSION,
    upstream: { repository: raw.upstream.repository, branch: raw.upstream.branch },
    topics: topics.map((topic) => ({
      name: topic.name,
      ref: topic.ref,
      base: topic.base,
      onto: topic.onto ?? 'upstream'
    }))
  }
}

/** Stable key order and a trailing newline, so a sync's manifest diff is only the moved refs. */
export function serializeManifest(manifest) {
  const plain = {
    version: manifest.version,
    upstream: { repository: manifest.upstream.repository, branch: manifest.upstream.branch },
    topics: manifest.topics.map((topic) => ({
      name: topic.name,
      ref: topic.ref,
      base: topic.base,
      ...(topic.onto === 'integration' ? { onto: 'integration' } : {})
    }))
  }
  return `${JSON.stringify(plain, null, 2)}\n`
}

/** Points restacked topics at their new ref and base; other topics are unchanged. */
export function updateManifest(manifest, topicResults) {
  const byName = new Map(topicResults.map((result) => [result.name, result]))
  return {
    ...manifest,
    topics: manifest.topics.map((topic) => {
      const result = byName.get(topic.name)
      return result?.newRef && result?.newBase
        ? { ...topic, ref: result.newRef, base: result.newBase }
        : topic
    })
  }
}

function assertDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Sync date must be YYYY-MM-DD, got ${JSON.stringify(date)}`)
  }
}

/** Sync key of a branch this automation publishes, or null for any other branch. */
export function syncKeyOfBranch(branch) {
  let key = null
  if (branch.startsWith(STACK_SYNC_PREFIX)) {
    key = branch.slice(STACK_SYNC_PREFIX.length).split('/')[0]
  } else if (branch.startsWith(INTEGRATION_PREFIX)) {
    key = branch.slice(INTEGRATION_PREFIX.length)
  } else if (branch.startsWith(MAIN_UPDATE_PREFIX)) {
    key = branch.slice(MAIN_UPDATE_PREFIX.length)
  }
  return key !== null && SYNC_KEY.test(key) ? key : null
}

/** Never reuse a published name: a second sync on one day gets `<date>-2`, then `-3`. */
export function pickSyncKey(date, existingBranches) {
  assertDate(date)
  const taken = new Set(existingBranches.map(syncKeyOfBranch).filter(Boolean))
  if (!taken.has(date)) {
    return date
  }
  for (let suffix = 2; ; suffix += 1) {
    if (!taken.has(`${date}-${suffix}`)) {
      return `${date}-${suffix}`
    }
  }
}

export function syncBranchNames(key, topicNames) {
  return {
    stacks: Object.fromEntries(
      topicNames.map((name) => [name, `${STACK_SYNC_PREFIX}${key}/${name}`])
    ),
    integration: `${INTEGRATION_PREFIX}${key}`,
    mainUpdate: `${MAIN_UPDATE_PREFIX}${key}`
  }
}

/** Orders keys oldest first: by date, then by same-day suffix. */
export function compareSyncKeys(left, right) {
  const leftDate = left.slice(0, 10)
  const rightDate = right.slice(0, 10)
  if (leftDate !== rightDate) {
    return leftDate < rightDate ? -1 : 1
  }
  const suffix = (key) => Number(SYNC_KEY.exec(key)?.[1] ?? 1)
  return suffix(left) - suffix(right)
}

/**
 * Automation-published branches a human may delete: every sync key except the newest `keep`
 * and any key the manifest still points at. Other branches are never listed.
 */
export function pruneCandidates({ branches, manifest, keep }) {
  const referenced = new Set(
    manifest.topics.map((topic) => syncKeyOfBranch(topic.ref)).filter(Boolean)
  )
  const keys = [...new Set(branches.map(syncKeyOfBranch).filter(Boolean))].sort(compareSyncKeys)
  const kept = new Set([...keys.slice(Math.max(0, keys.length - keep)), ...referenced])
  return branches
    .filter((branch) => {
      const key = syncKeyOfBranch(branch)
      return key !== null && !kept.has(key)
    })
    .sort()
}
