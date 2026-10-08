# Fork Upstream Sync

## Model

This fork (`Meapri/orca`) follows `stablyai/orca`. Every fork change lives in a **topic stack**:
a short, linear series of reviewable commits on top of upstream `main`. Stacks are built
independently of each other, each on upstream alone. What each topic owns is listed in
[`fork-topics.md`](./fork-topics.md).

[`config/fork-stacks.json`](../../config/fork-stacks.json) lists the topics in integration
order, each with its stack branch (`ref`) and the commit it was last built on (`base`):

| Order | Topic             | Why here                                                        |
| ----- | ----------------- | --------------------------------------------------------------- |
| 1     | `terminal`        | first, so no later topic can silently change terminal behaviour |
| 2     | `sync-automation` | this workflow, the manifest, and the upstream-only guards       |
| 3     | `runtime-remote`  |                                                                 |
| 4     | `accounts`        |                                                                 |
| 5     | `orcad-runtime`   |                                                                 |
| 6     | `distribution`    | last: it renames identity-bearing values in files others add    |

From those stacks the sync builds:

- **Integration branch** `integrate/fork-<key>`: upstream `main`, then a `--no-ff` merge of each
  stack in manifest order, then one commit that records the new stack refs in the manifest.
- **Main-update commit** on `main-update/fork-<key>`: its tree is exactly the integration tree,
  its first parent is the current `main`, its second parent is the integration commit
  (`git commit-tree <integration>^{tree} -p origin/main -p <integration>`). It extends `main`,
  so adopting it is a fast-forward. `main` is never force-pushed and never rebased.

`<key>` is the UTC date of the sync (`2026-10-09`); a second sync on the same day gets `-2`.

A topic may set `"onto": "integration"` for cross-topic fixups that only apply on top of
several stacks. Such topics come after all others; their commits are re-applied on top of the
merged stacks instead of upstream, and their `base` is the merged-stacks commit they were last
built on.

### Branch names

| Branch                     | Written by          | Meaning                                    |
| -------------------------- | ------------------- | ------------------------------------------ |
| `stack/<topic>`            | humans              | the stack as a human last built it         |
| `stack-sync/<key>/<topic>` | automation (new)    | a re-stacked topic; never moved afterwards |
| `integrate/fork-<key>`     | automation / humans | upstream + every stack + manifest commit   |
| `main-update/fork-<key>`   | automation / humans | the main-update commit, proposed by PR     |

`stack/<topic>` and `stack/<topic>/<anything>` cannot both exist (git stores refs as paths),
which is why re-stacked topics live under the separate `stack-sync/` prefix.

## Where the Sync Runs

The daily sync runs on the fork owner's server (rizi: Linux arm64, 4 cores, 23 GB), not in
GitHub Actions. The fork has no `FORK_SYNC_TOKEN`, and Actions' default `GITHUB_TOKEN` cannot
push a commit that changes `.github/workflows/`, which most upstream syncs do. The server pushes
with the owner's own `gh` login (scopes `repo` and `workflow`), so no repository secret exists.
`.github/workflows/fork-upstream-sync.yml` stays as a manual fallback (`workflow_dispatch`
only); it has no schedule, so it never races the server.

## Server Sync

`config/scripts/fork-stack-server-sync.mjs` does what the workflow does, on one machine:

1. **Self-update.** It fetches `origin` and runs the newest copy of itself: from `origin/main`
   once main carries the script, otherwise from `origin/stack/sync-automation`. The tools
   checkout must be a dedicated worktree (`<clone>-wt/_sync-tools`) so this never moves a
   checkout someone works in.
2. **Lock** (`<logs>/.sync.lock`). A second run exits as an environment error; a lock left by a
   dead process is taken over.
3. **Environment.** `pnpm`, `bun` (`config/.bun-version`, which the unit test runner needs) and
   a logged-in `gh` must be on `PATH`.
4. **Re-stack and integrate** in the dedicated worktree `<clone>-wt/_sync`, through the same
   `runStackSync` the workflow uses: upstream PR lookup, dropping commits upstream accepted,
   rerere, the integration merges and the main-update commit. The manifest comes from
   `origin/main`; until main adopts the stacks it comes from the newest
   `main-update/fork-*` branch.
5. **No-change shortcut.** When the main-update tree equals the head tree of an open
   main-update PR, the run reports "no change" and stops.
6. **Checks** on the integration commit, after `pnpm install --frozen-lockfile` (root and
   `mobile/`; the shared pnpm store keeps this to seconds): `pnpm tc`; every `pnpm lint` step
   separately, so a known failure in one step does not hide the others;
   `regenerate-xterm-patches.mjs --check`; the unit tests the fork's diff reaches (tests it
   changed plus the sibling tests of every source file it changed) together with the terminal
   suites (`terminal-pane/`, `pane-manager/`); and mobile `tsc` plus its tests. On Sundays (UTC)
   the whole unit suite runs too (`--full-tests=auto`; `always`/`never` override). About 35–50
   minutes on rizi, the full suite adds about 95.
7. **Flaky tests and baseline.** A failed test file first runs again alone on the integration;
   tests that pass then are reported as flaky (usually a timeout on the loaded 4-core machine)
   and not counted. When a check still fails, the failed items (type errors without positions, lint
   steps, test files, unhandled-error titles) are rerun on upstream main in
   `<clone>-wt/_sync-baseline`. Failures upstream shares are reported as known, not as
   regressions. A failure that names nothing (a crash, a timeout) always counts as a regression;
   the xterm check has no upstream baseline.
8. **Publish** (skipped by `--dry-run`): confirm `origin/main` did not move, push every new
   branch with one `git push --atomic` (never `--force`), open the main-update PR, and close the
   older open main-update PRs as superseded.

```sh
env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME PATH="$HOME/.local/bin:$PATH" \
  node <clone>-wt/_sync-tools/config/scripts/fork-stack-server-sync.mjs [--dry-run] \
  [--full-tests=auto|always|never] [--date=YYYY-MM-DD] [--logs=<dir>]
```

The `env -u` clears XDG paths a service account may point elsewhere, so `gh` finds the owner's
login.

| Exit code | Outcome                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| 0         | success: checks passed and the PR is open (or `--dry-run` would have opened it)          |
| 10        | no change: upstream did not move, or an open PR already has this tree                    |
| 20        | conflict: a topic or the integration merge stopped on a conflict rerere could not settle |
| 30        | checks failed: at least one regression against upstream main                             |
| 40        | environment error: lock held, missing tool or login, git or `gh` failure, `main` moved   |

Every run writes to `<clone>-sync-logs/` (on rizi `/home/naen/work/orca-sync-logs/`):

- `latest.md`: a few lines in Korean for the notifier (outcome, stacks, the blocked commit and
  files, check results, PR, duration);
- `latest.json`: the same, machine-readable, with every check's regressions and known failures;
- `latest-detail.md`: the full English report (the workflow's summary plus a checks table);
- `runs/<date>T<time>/`: copies of the three, `report.json`, and one log per check and per
  baseline rerun.

One-time setup on the server:

```sh
git -C <clone> worktree add --detach <clone>-wt/_sync-tools origin/stack/sync-automation
ln -s <clone>-wt/_deps/node_modules <clone>-wt/_sync-tools/node_modules   # esbuild for the script
git -C <clone> config rerere.enabled true && git -C <clone> config rerere.autoupdate true
```

`_sync` and `_sync-baseline` are created on the first run. Leave all three worktrees to the
script; do manual work in other worktrees.

## What the Sync Does (Actions Fallback)

`.github/workflows/fork-upstream-sync.yml` runs only on demand (`dry_run` re-stacks and
reports, but pushes nothing), and only on the fork. Without `FORK_SYNC_TOKEN`, its push fails
whenever the integration changes `.github/workflows/`; prefer the server sync.

1. **restack** (holds no secrets: it may run upstream xterm's npm toolchain). It fetches
   upstream `main`, reads the manifest from fork `main`, and looks up every `Upstream-PR:`
   trailer in one read-only GraphQL call (the only step that sees the job token). Then
   `fork-stack-sync.mjs restack`, for each topic in order:
   - takes the commits `<base>..origin/<ref>` (merge commits are refused: stacks are linear);
   - if `base` already equals the new upstream, reuses the stack as is;
   - otherwise cherry-picks each commit onto the new upstream with rerere on, dropping the
     commits upstream already has (next section);
   - on a conflict rerere cannot settle, aborts that topic and records the topic, the commit
     (hash and subject) and the conflicted files, then continues with the other topics so one
     run reports every blocked topic.

   If every topic re-stacked, it merges them into the integration commit, records the new refs
   in the manifest, and builds the main-update commit. If the integration tree equals `main`'s
   tree the run is **up to date** and stops. A blocked topic or integration merge fails the job.

2. **publish** pushes the new `stack-sync/<key>/*` branches and `integrate/fork-<key>` with one
   plain `git push --atomic` from a fresh runner. Every name is new, so nothing is overwritten.
3. **Checks** run on the pushed integration commit and mirror `pr.yml` and `unit-tests.yml`
   (which can't be called directly, because their checkout pins the triggering SHA):
   `pnpm tc` and `pnpm lint`, the sharded unit tests, relay integration tests,
   `regenerate-xterm-patches.mjs --check`, and `pnpm run build:release:parallel`.
4. **pull_request**, only when every check passed: confirms `main` has not moved, pushes
   `main-update/fork-<key>`, opens a PR into `main`, and closes older open main-update PRs as
   superseded. A human reviews and merges it (see [Promoting](#promoting-and-pruning-refs)).
5. **report** always writes the run summary (`$GITHUB_STEP_SUMMARY`): per-topic results, every
   dropped commit with its reason, conflicts settled automatically, blocked topics with the
   commands to resume, failed jobs, and the diffstat `main` would take. On failure it also
   comments on the open main-update PR, if any. It updates the
   **Upstream sync needs attention** issue only when the repository has Issues enabled
   (`gh api repos/{repo} --jq .has_issues`); Issues being off never fails the run. The run's
   own status is the failure signal.

The scripts behind the workflow are `config/scripts/fork-stack-*.mjs`: pure, unit-tested
decisions (`fork-stack-manifest`, `fork-stack-restack-plan`, `fork-stack-xterm-conflicts`,
`fork-stack-report`) and a thin git/gh layer (`fork-stack-sync`, `fork-stack-git`,
`fork-stack-conflict-settling`, `fork-stack-integration`).

### Which commits are dropped

A re-stack never drops a commit silently: each one is listed in the report with its reason.

- **Upstream accepted it** (reported under "Dropped because upstream accepted the change"):
  - its `Upstream-PR: stablyai/orca#N` trailer names a PR that merged into upstream `main`, and
    the merge commit is in the fetched upstream. Upstream's version wins even if review
    changed it;
  - its `(cherry picked from commit <sha>)` line (from `git cherry-pick -x`) names a commit
    that is now in upstream, such as a cherry-picked upstream PR that has since merged;
  - `git cherry` finds an upstream commit with the same patch id.
- **It became empty**: it applies cleanly but changes nothing, because upstream already made
  the change as part of something larger.

When every commit of a topic is dropped, the report says so; remove the topic from the
manifest.

## Conflict-Resolution Principles

1. **Terminal first, and never lose terminal behaviour.** The terminal stack integrates first.
   When upstream reworks terminal code, port the fork's behaviour onto upstream's new structure
   rather than reverting upstream.
2. **Drop fork code that upstream has replaced.** If upstream now does what a fork commit did,
   drop the commit (and its tests) instead of keeping two implementations. Note it in the
   commit message of whatever replaces it.
3. **Distribution keeps the fork's behaviour.** Fork identity (app names, update feeds, release
   channels, signing) always wins over upstream's in the distribution topic.
4. **i18n catalogs and lockfiles keep both sides.** Keep every key from both sides in
   localization catalogs. Never hand-edit `pnpm-lock.yaml`: take upstream's side, then
   regenerate it (`pnpm install --lockfile-only`) in the commit that changes `package.json`.
5. **Generated xterm patches are regenerated, never hand-merged** (see below). The automation
   settles a commit whose only conflicts are generated xterm bundles, blob-id/offset noise in
   `xterm-src/*.src.patch`, or xterm patch hashes in the lockfile: it keeps the topic's side and
   appends a `chore(xterm): regenerate patches` commit to that topic.
6. **Keep a change in the topic that owns it.** If two stacks overlap, move the overlapping
   change into the later topic or into an `onto: "integration"` fixup topic.

## rerere

Git's rerere records how you resolved a conflict and replays it when the same conflict recurs.
Daily re-stacks meet the same conflicts repeatedly until the manifest moves forward, so enable
it wherever you re-stack:

```sh
git config rerere.enabled true
git config rerere.autoupdate true   # stage replayed resolutions
git rerere status                   # paths with a recorded preimage in this conflict
git rerere diff                     # your resolution so far, against the conflict
git rerere forget <path>            # drop a wrong recorded resolution, then resolve again
```

In Actions, `.git/rr-cache` is restored before and saved after every run
(`fork-stack-rerere-<run id>`, restored by prefix), so resolutions accumulate across runs. Before
merging the stacks, the workflow also replays the merges of the integration that `main` last
adopted (the second parent of the main-update commit, also through a merge-button commit) and
records their resolutions, the way `contrib/rerere-train.sh` does. A conflict between stacks that
a human resolved once is therefore resolved again automatically. Replayed resolutions are listed
under "Conflicts settled automatically" in the report: review them.

On the server, `.git/rr-cache` is the clone's own and is shared by every worktree, so a
resolution recorded in any of them (by the script or by hand) is replayed by the next run. CI
does not need a resolution recorded elsewhere: the manifest records the stack you rebuilt by
hand, so the next run starts from it.

## Manual Sync

Use Node 24 and pnpm (`mise exec -- …`). Never `--force`.

```sh
git fetch origin && git fetch upstream
git config rerere.enabled true && git config rerere.autoupdate true
DATE=$(date -u +%F)
UPSTREAM=$(git rev-parse upstream/main)
```

**1. Re-stack the topic the workflow reported as blocked.** Take `base` and `ref` from
`config/fork-stacks.json` on `main`:

```sh
TOPIC=runtime-remote BASE=<base> REF=<ref>
git switch -c restack/$TOPIC $UPSTREAM
git cherry-pick $BASE..origin/$REF
# On a conflict: resolve following the principles above, `git add`, `git cherry-pick --continue`.
# For a commit upstream already has: `git cherry-pick --skip`, and say so in the PR.
git push origin HEAD:refs/heads/stack-sync/$DATE/$TOPIC
```

**2. Let the script do the rest.** Point a copy of the manifest at the stack you just pushed
(`ref` = `stack-sync/<DATE>/<topic>`, `base` = `$UPSTREAM`) and run the same driver the
workflow runs. It reuses that topic, re-stacks the others, merges, writes the manifest
commit, and builds the main-update commit:

```sh
cp config/fork-stacks.json /tmp/fork-stacks.json   # then edit the topic you rebuilt
git switch --detach origin/main
node config/scripts/fork-stack-sync.mjs restack --manifest=/tmp/fork-stacks.json \
  --report=/tmp/fork-sync/report.json --date=$DATE \
  --xterm-work-dir=/tmp/xterm --bundle=/tmp/fork-sync/sync.bundle
node config/scripts/fork-stack-report.mjs summary --report=/tmp/fork-sync/report.json | less
```

**3. Check the integration branch**, from `refs/fork-sync/integrate/fork-<key>`:

```sh
git switch --detach refs/fork-sync/integrate/fork-$DATE
pnpm install --frozen-lockfile
node config/scripts/regenerate-xterm-patches.mjs --check --work-dir=/tmp/xterm
pnpm tc && pnpm lint && pnpm test
```

**4. Publish and propose:**

```sh
mapfile -t specs < <(node config/scripts/fork-stack-report.mjs refspecs \
  --report=/tmp/fork-sync/report.json --kinds=stack,integration,main-update)
git push --atomic origin "${specs[@]}"
gh pr create --repo Meapri/orca --base main --head main-update/fork-$DATE \
  --title "chore(fork): update main to integrate/fork-$DATE" \
  --body-file <(node config/scripts/fork-stack-report.mjs pr-body --report=/tmp/fork-sync/report.json)
```

Without the script, step 2 is: `git switch -c integrate/fork-$DATE $UPSTREAM`, then
`git merge --no-ff origin/<ref>` for each topic in manifest order, then update
`config/fork-stacks.json` (each re-stacked topic's `ref` and `base`) and commit it, then
`M=$(git commit-tree "HEAD^{tree}" -p origin/main -p HEAD -m "chore(fork): update main to integrate/fork-$DATE")`
and push `HEAD` to `integrate/fork-$DATE` and `$M` to `main-update/fork-$DATE`.

To add, remove, or reorder topics, edit the manifest copy in step 2 the same way; the
manifest commit carries the change to `main`.

## Promoting and Pruning Refs

**Merging a main-update PR.** Prefer a fast-forward, which keeps `main` free of extra merge
commits and marks the PR merged on GitHub:

```sh
git fetch origin main-update/fork-<key>
git push origin <main-update sha>:main
```

GitHub's "Create a merge commit" button also works: it adds one merge commit whose tree is
still the integration tree, and the next sync looks through it. Never squash or rebase-merge:
that drops the link to the integration commit.

**Promoting a stack.** The manifest on `main` is the source of truth, so after a merged
main-update PR every topic already points at its newest `stack-sync/` branch; no promotion is
required. To keep human-facing `stack/<topic>` branches current as well, a maintainer may move
them by hand (`git push --force-with-lease origin stack-sync/<key>/<topic>:stack/<topic>`) and
point the manifest back at `stack/<topic>` in the next manual sync. Automation never does this.

**Pruning.** `node config/scripts/fork-stack-sync.mjs prune-plan --keep=7` prints
`git push origin --delete …` for automation branches (`stack-sync/`, `integrate/fork-`,
`main-update/fork-`) older than the newest seven sync keys and not referenced by the manifest.
It deletes nothing itself. Commits that reached `main` stay reachable through the main-update
commits after their branches are deleted.

## Upstream PRs Carried by the Fork

The fork carries the user's open upstream PRs as ordinary stack commits, one PR per commit
where practical, each with a trailer:

```text
Upstream-PR: stablyai/orca#23334
```

A stack may also carry a byte-identical cherry-pick of someone else's unmerged upstream PR
commit; make it with `git cherry-pick -x` so the source commit is recorded. The automation drops
such commits only when upstream has merged the equivalent change (rules above) and lists each
drop in the report and the main-update PR, so a reviewer can check that nothing the fork still
needs was lost. It never pushes to, comments on, or opens PRs in `stablyai/orca`; its only
upstream API use is one read-only GraphQL query per run.

## Repository Setup

- **No secret is needed for the daily sync**: the server pushes and opens PRs with the
  owner's `gh` login. A PR opened that way also triggers the fork's PR checks.
- **Actions fallback only:** Settings → Actions → General → Workflow permissions read and
  write, allow GitHub Actions to create pull requests, and (optionally) a `FORK_SYNC_TOKEN`
  fine-grained token with Contents, Workflows and Pull requests read and write. Without it the
  fallback cannot push workflow-file changes, and a PR it opens does not trigger PR checks.
- **Branch protection on `main`:** require a pull request, allow the maintainer who merges
  main-update PRs to push a fast-forward (or allow merge commits), and keep force-pushes and
  deletions blocked. Do not require linear history if you use the merge button.
- **Issues** are optional. With Issues off, the run summary and run status are the report.

## Upstream Workflows Guarded on the Fork

Each guard is one `github.repository == 'stablyai/orca'` condition, added as an extra clause
where a job already had an `if`, so re-stacking stays conflict-light.

| Workflow                        | Why                                                    |
| ------------------------------- | ------------------------------------------------------ |
| `homebrew-bump.yml`             | opens PRs in `stablyai/homebrew-orca`                  |
| `pullfrog.yml`                  | Pullfrog agent with upstream's model API keys          |
| `issue-os-labeler.yaml`         | labels upstream issue forms; noise on fork issues      |
| `windows-signing-rehearsal.yml` | SignPath signing with upstream's token                 |
| `mobile-ios-release.yml`        | App Store Connect / TestFlight with upstream's keys    |
| `agent-state-rules-publish.yml` | publishes rules releases apps fetch from stablyai/orca |

Already guarded upstream: `release-cut`, `release-mac-build`, `hourly-mac-build`,
`daily-mac-build`, `adhoc-mac-build`, `dev-channel-win-build`, `docs`, `release-policy`,
`readme-downloads-badge`. The `cloud-*` workflows only run when
`vars.ORCA_CLOUD_OPERATIONS_ENABLED` is `true`, which the fork does not set.
`release-javascript.yml` and `relay-windows-process-tree.yml` are reusable workflows; their
callers are the guarded release workflows and `release-javascript-benchmark`, which passes a
placeholder key. The other workflows upstream added since the fork's
previous base (`macos-updater-tests`, `node-server-tests`, `release-javascript-benchmark`,
`ssh-hostile-hosts`, `ssh-windows-hosts`, `win-orcad-serve-switch-e2e`) are PR or manual test
workflows without upstream secrets, so they stay enabled.

## xterm Patches During a Re-stack

[`xterm-patch-regeneration.md`](./xterm-patch-regeneration.md) is the authority. In short:

- `config/patches/xterm-src/*.src.patch` is the source of truth. The
  `config/patches/@xterm__*.patch` bundles and their `pnpm-lock.yaml` hashes are generated.
  Never hand-merge a generated patch: take either side, then run `--write`.
- Regenerate with `regenerate-xterm-patches.mjs --write`, then `pnpm install`, then `--check`.
  Build outside this repository (`--work-dir=/tmp/xterm`).

### xterm 3-way merge

Use this when upstream and a stack commit changed hunks in the same source patch, or when the
re-stacked source patch no longer applies to the pinned xterm commit. Merge the TypeScript
sources, not the patch text. Run it from the repository root while the cherry-pick is stopped
on the conflict (`<commit>` is the stack commit being applied):

```sh
PATCH=config/patches/xterm-src/@xterm__xterm@<version>.src.patch
PIN=$(node -p "require('./config/patches/xterm-upstream.json').upstream.commit")
git show <commit>^:$PATCH > /tmp/base.patch     # the stack's old base
git show <commit>:$PATCH > /tmp/fork.patch      # the stack commit
git show HEAD:$PATCH > /tmp/upstream.patch      # the new upstream side

X=/tmp/xterm-merge   # outside the repo; any xterm.js clone
[ -d $X ] || git clone --quiet https://github.com/xtermjs/xterm.js.git $X
# Each side is one commit on top of the base side, so git merges the sources 3-way.
git -C $X switch -qfC sync-base $PIN && git -C $X apply --index /tmp/base.patch && git -C $X commit -qm base
for side in fork upstream; do
  git -C $X switch -qfC sync-$side sync-base
  git -C $X reset -q --hard $PIN && git -C $X reset -q --soft sync-base
  git -C $X apply --index /tmp/$side.patch && git -C $X commit -qm $side
done
git -C $X switch -q sync-fork && git -C $X merge sync-upstream   # resolve the real conflicts in src/
git -C $X diff $PIN -- src/ > $PATCH

node config/scripts/regenerate-xterm-patches.mjs --write --work-dir=/tmp/xterm
pnpm install && node config/scripts/regenerate-xterm-patches.mjs --check --work-dir=/tmp/xterm
git add config/patches pnpm-lock.yaml && git cherry-pick --continue
```

For an addon, pass `--directory=addons/<name>` to each `git apply`, and diff with
`git -C $X/addons/<name> diff --relative $PIN -- src/`. `--write` rewrites the patch into its
canonical form, so a hand-produced diff is fine.

A version bump on the upstream side changes `upstream.commit`, so the upstream patch applies to
a newer commit than the other two. First move the base and fork patches onto the new commit
with `git apply -3`, which uses the patch's `index` blob ids to fall back to a 3-way merge.
Then run the loop above with `PIN` set to the new commit.
