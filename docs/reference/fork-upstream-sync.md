# Fork Upstream Sync

## Scope

This fork (`Meapri/orca`) follows `stablyai/orca`. `.github/workflows/fork-upstream-sync.yml`
brings upstream `main` into fork `main` every Monday (03:17 UTC), and on demand from the
Actions tab. Two rules hold whether the sync is automatic or manual:

- A sync is a real merge commit of upstream `main` into fork `main`. Never rebase fork
  history onto upstream.
- Fork `main` only ever fast-forwards. Never force-push it, and never push to upstream.

## What the Workflow Does

1. **merge** fetches upstream `main`. If fork `main` already contains it, the run stops.
   Otherwise it creates `sync/upstream-<date>` from fork `main` (`-2`, `-3` for a second
   run the same day) and runs `git merge --no-ff upstream/main`. The merge job holds no
   secrets, because the xterm check runs upstream xterm's npm toolchain.
2. **xterm patches.** If the merge is clean, it runs
   `regenerate-xterm-patches.mjs --check`. If that fails, it runs the documented
   regeneration (`--write`, then `--check`) and commits the result on top of the merge.
   Some conflicts are only in files the generator rederives, and the merge settles those
   by taking the fork side and running `--write` before committing, so the merge commit
   already carries the regenerated patches. These conflicts qualify:
   - the generated `config/patches/@xterm__*.patch` bundles,
   - `index` lines and new-side hunk offsets in the `xterm-src/*.src.patch` sources,
   - xterm patch hashes in `pnpm-lock.yaml`.

   Any other conflict, including real hunk conflicts in a source patch, aborts the merge.

3. **publish** pushes the sync branch from a fresh runner, never with `--force`.
4. **static_checks** (`pnpm tc`, `pnpm lint`), **unit_plan** plus the sharded
   **unit_tests**, **relay_integration**, and **build** (`pnpm run build:release:parallel`)
   run on the pushed commit. They mirror `pr.yml` and `unit-tests.yml`. Those workflows
   can't be called directly, because their checkout pins the triggering SHA.
5. **finalize.** If everything passed, it re-fetches `main` and confirms `main` is still an
   ancestor of the sync branch. Then it pushes the sync commit to `main` with a plain
   push, which the server refuses unless it is a fast-forward. It then closes the
   tracking issue. The `dry_run` input skips this step.

   Otherwise it opens or updates one issue titled **Upstream sync needs attention**. The
   issue lists the conflicts or failed jobs, the xterm log tail, the upstream commits,
   and the commands to finish. After a conflict the sync branch stays at fork `main` (the
   merge was aborted). After a failed check it holds the merge commit.

## Repository Settings

- **Settings → Actions → General → Workflow permissions:** allow read and write, so the
  default token can push `sync/*` branches and edit issues.
- **`FORK_SYNC_TOKEN` secret (needed in practice).** The default `GITHUB_TOKEN` can't push
  a commit that changes `.github/workflows/`, and most upstream syncs do. Create a
  fine-grained token scoped to this repository only, with **Contents: read and write** and
  **Workflows: read and write**. Pushes with it also trigger the fork's own `push`
  workflows on `main`, just as a manual sync does.
- **Branch protection on `main`**, if any, must let that token push directly. Otherwise the
  fast-forward is refused and the issue says so.

## Upstream Workflows Guarded on the Fork

Each guard is one `github.repository == 'stablyai/orca'` condition, so upstream merges stay
conflict-light. Where a job already had an `if`, the guard is added as an extra clause.

| Workflow                        | Why                                                 |
| ------------------------------- | --------------------------------------------------- |
| `homebrew-bump.yml`             | opens PRs in `stablyai/homebrew-orca`               |
| `pullfrog.yml`                  | Pullfrog agent with upstream's model API keys       |
| `issue-os-labeler.yaml`         | labels upstream issue forms; noise on fork issues   |
| `windows-signing-rehearsal.yml` | SignPath signing with upstream's token              |
| `mobile-ios-release.yml`        | App Store Connect / TestFlight with upstream's keys |

These were already guarded upstream: `release-cut`, `release-mac-build`, `hourly-mac-build`,
`daily-mac-build`, `adhoc-mac-build`, `dev-channel-win-build`, `docs`, `release-policy`,
`readme-downloads-badge`. The `cloud-*` workflows only run when
`vars.ORCA_CLOUD_OPERATIONS_ENABLED` is `true`, which the fork does not set.
`orcad-release` and `mobile-android-release` publish to this repository's own releases and
only run on a pushed tag, so they stay enabled.

## Manual Sync

Use Node 24 and pnpm 12 (`mise exec -- …`).

```sh
git fetch origin && git fetch upstream
git switch -c sync/upstream-$(date -u +%F) origin/main
git merge --no-ff upstream/main
# resolve conflicts; for xterm patches see below
node config/scripts/regenerate-xterm-patches.mjs --check
pnpm install --frozen-lockfile
pnpm tc && pnpm lint && pnpm test
git push origin HEAD
git push origin HEAD:main   # fast-forward only; never --force
```

`node config/scripts/fork-upstream-sync.mjs merge --report=/tmp/sync.json` runs the
workflow's merge step locally. Its `xterm --report=/tmp/sync.json --work-dir=/tmp/xterm` step
runs the xterm step. Both work on the current checkout.

## xterm Patches During a Sync

[`xterm-patch-regeneration.md`](./xterm-patch-regeneration.md) is the authority. The short
version:

- `config/patches/xterm-src/*.src.patch` is the source of truth. The
  `config/patches/@xterm__*.patch` bundles and their `pnpm-lock.yaml` hashes are generated.
  Never hand-merge a generated patch. Take either side, then run `--write`.
- Regenerate with `regenerate-xterm-patches.mjs --write`, then `pnpm install`, then
  `--check`. Build outside this repository (`--work-dir=/tmp/xterm`).

### xterm 3-way merge

Use this procedure when both sides changed hunks in the same source patch, or when the
merged source patch no longer applies to the pinned xterm commit. Merge the TypeScript
sources, not the patch text. Run it from the repository root while the Orca merge is
still in progress:

```sh
PATCH=config/patches/xterm-src/@xterm__xterm@<version>.src.patch
PIN=$(node -p "require('./config/patches/xterm-upstream.json').upstream.commit")
git show "$(git merge-base HEAD MERGE_HEAD)":$PATCH > /tmp/base.patch
git show HEAD:$PATCH > /tmp/fork.patch
git show MERGE_HEAD:$PATCH > /tmp/upstream.patch

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
git add config/patches pnpm-lock.yaml
```

For an addon, pass `--directory=addons/<name>` to each `git apply`, and diff with
`git -C $X/addons/<name> diff --relative $PIN -- src/`. `--write` rewrites the patch into
its canonical form, so a hand-produced diff is fine.

A version bump on the upstream side changes `upstream.commit`, so the upstream patch
applies to a newer commit than the other two. First move the base and fork patches onto
the new commit with `git apply -3`. It uses the patch's `index` blob ids to fall back to a
3-way merge. Then run the loop above with `PIN` set to the new commit. Commit the source
patch, the regenerated bundles, and the lockfile together in the merge commit.
