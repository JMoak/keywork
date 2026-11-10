# Cutting a keywork release

> The launch rail (G3, decided in
> [`backlog/108-survivability-and-launch-rail.md`](backlog/108-survivability-and-launch-rail.md)).
> The bar is the 60-second screencast: install → onboarding → first turn → first undo.

## What ships

Single-file binaries, one per target, each **built on its own platform** and smoke-tested
there (`--version`, `doctor`) before upload. OpenTUI embeds its native library and tree-sitter
assets through `import(…, { with: { type: "file" } })`, which is exactly what
`bun build --compile` bakes in, so there is nothing to install beside the binary.

| asset | built on |
|---|---|
| `keywork-linux-x64` | `ubuntu-latest` (Linux is primary) |
| `keywork-linux-arm64` | `ubuntu-24.04-arm` |
| `keywork-windows-x64.exe` | `windows-latest` |
| `keywork-darwin-arm64` | `macos-latest` |
| `keywork-darwin-x64` | `macos-15-intel` |

Every asset has a `<asset>.sha256` beside it and the release carries a combined
`SHA256SUMS`. The npm fallback (`dist/npm`, package `keywork-cli` since `keywork` is another
project's name on the registry, `bin` = the bundled CLI that
runs on an installed Bun with `@opentui/core` as a normal dependency) is built on every
release and published directly to npm when the repository variable
`NPM_PUBLISH` is `true`. Publishing uses GitHub Actions trusted publishing with OIDC;
the workflow uses no npm token. A successful release makes the npm package public.

## Automatic releases

`release.yml` handles pushes to `main`, stable `v*` tags, and manual runs. The first
release under this policy is explicitly tagged `v0.2.2`; main automation waits for
that real tag before calculating subsequent versions. Existing feature history cannot
turn this first release into `0.3.0`.

After that baseline, commits since the latest reachable stable release tag determine
the version: `fix` and `perf` increment the patch, `feat` increments the minor, and
`!` or a `BREAKING CHANGE` footer increments the major. The highest applicable change
wins. Docs, chores, and ordinary reverts do not independently publish; an unreleased
change paired with its revert cancels out. Squash-merge titles therefore matter.

Every main push runs the same Linux and Windows checks as a PR through reusable
`ci.yml`, once. A release then builds and smoke-tests all five native targets and the
npm package, checks every checksum, creates its tag and GitHub draft, publishes and
verifies npm, and makes the GitHub release public. The install rail is timed against
that public release. Tags created by the workflow need no second workflow run.

The planned version is assigned at build time to the binary and npm package, including
`--version` and server metadata. Source manifests retain their development versions;
automation does not commit version bumps. The server
contract has its own number beside it (`info.x-keywork-contract`, from
`packages/server/src/contract.ts`), and a release that changed a route or an event bumps
that one too; [`events.md`](events.md) says when a minor and when a major, and
`bun run contract:fixtures` regenerates the two fixtures whose diff is the review.

To reproduce an automatic release, check out its tag and pass the version explicitly:

```sh
git checkout v0.2.3
bun scripts/release/build.ts --version 0.2.3 --expect-tag v0.2.3
bun scripts/release/build-npm.ts --version 0.2.3
```

The binary builder rejects disagreement between `--version` and `--expect-tag`.
Manual workflow runs on `main` use the same commit rules; running against a stable
tag rebuilds that exact release. Main and tag runs serialize in one release group.
An older queued main commit skips publication if a newer release is already ahead
of it; unrelated branch tags do not become its version baseline.

## Locally

```sh
bun run build:binary          # dist/release/<host asset> + .sha256, smoke-tested
bun run build:npm             # dist/npm/, smoke-tested with `bun dist/npm/bin/keywork.js --version`
bun scripts/release/build.ts --outdir /tmp/out --version 0.0.0-local
```

`keywork --version` prints the build-time version in a release binary and the manifest
version when run from source.

## npm trusted publishing

The generated package is `keywork-cli`, assigned the planned release version, with `bin.keywork` pointing at
`bin/keywork.js`, the canonical repository `git+https://github.com/JMoak/keywork.git`,
and public access on `https://registry.npmjs.org`. Ratchet is carried inside the bundle;
OpenTUI and web-tree-sitter remain exact public dependencies. The allowlist also includes
the license, notices, README, and shared-runtime upgrade guide.

Before the first publishing run, the package owner configures these settings; the workflow
does not create or verify them locally:

- On npm's **keywork-cli** package, add a GitHub Actions trusted publisher with organization
  or user **JMoak**, repository **keywork**, workflow filename **release.yml**, and no
  environment name. Those fields are case-sensitive. Enable **Allow npm publish**.
  Separate dist-tag management permission is not needed by this workflow.
- In **JMoak/keywork**, set the Actions repository variable **NPM_PUBLISH** to **true**.
  An unset or different value intentionally skips npm publication.

The publishing job runs on a GitHub-hosted Ubuntu runner with Node 24 and npm 12.2.2. It
has `id-token: write`, uses no token environment variable or token-placeholder `.npmrc`,
and retains all existing check, test, end-to-end, platform build, checksum, and GitHub
release gates. It verifies the package name, repository, public status, and agreement
between the package version and release tag, then inspects the pack list before running:

```sh
npm publish --access public --tag latest --loglevel verbose
```

GitHub OIDC generates provenance automatically for a public package from a public
repository; there is no local provenance claim before that CI run. The npm
[trusted-publishing guide](https://docs.npmjs.com/trusted-publishers/) describes the
required configuration and provenance conditions.

After the release succeeds, verify the public version with `npm view keywork-cli@latest version`
and inspect its provenance on npm. Direct publishing makes the version available immediately
after registry processing. If publication fails, rerun the original workflow or its
failed jobs. A tag already attached to that tested source resumes the same version;
a tag attached to different source fails without being moved. npm versions are accepted
as already published only when their `gitHead` matches that source. Registry errors fail
the run, and registry indexing checks have a bounded retry window. With npm publishing
enabled, GitHub publication also waits for npm `latest` to reach at least the planned
version; an older channel fails with a repair instruction, and a newer channel is retained.
Published GitHub
assets are never overwritten; an incomplete draft can be rebuilt. A later main release
waits for the preceding tag's GitHub and npm publications to finish. Published npm
versions are immutable; subsequent releases need a new version.

After the public release passes its install smoke check, `notify-app` verifies its public
tag and source SHA, reads the contract from that immutable source, and sends
`keywork-engine-published` to `JMoak/keywork-app`. Configure `DEPENDENCY_APP_ID` as an Actions
variable and `DEPENDENCY_APP_PRIVATE_KEY` as an Actions secret for the dependency GitHub
App installed on Keywork App with contents write permission. Missing credentials or failed
delivery fail the notification job visibly; rerunning that job retries delivery without
moving a tag or republishing assets. Keywork App independently verifies the canonical public
release and adopts only a compatible engine through its dependency PR workflow. Its daily
reconciliation recovers missed notifications.

Local preparation uses `bun run build:npm` and `npm pack --dry-run` from `dist/npm`.
Both commands prepare and inspect the package locally. The build checks the
version and runs `creatures report` under an empty home using its bundled Ratchet.

## Installing

```sh
curl -fsSL https://raw.githubusercontent.com/JMoak/keywork/main/scripts/install.sh | sh
irm https://raw.githubusercontent.com/JMoak/keywork/main/scripts/install.ps1 | iex
```

Both verify the SHA-256 before moving anything, honor `KEYWORK_VERSION` (a tag) and
`KEYWORK_INSTALL_DIR`, and finish by running `keywork --version`. Desktop entries live in
[`../packaging/`](../packaging/README.md).

## Pins

Every action in `.github/workflows/` is pinned to a full commit SHA with the version as a
comment (`scripts/check-pins.ts` enforces it). Bump by looking up the tag's commit
(`git ls-remote --tags https://github.com/<owner>/<action>`) and updating both the SHA and
the comment.

## Dependency updates

Dependabot reads the root Bun workspace and `bun.lock` on Mondays at 09:15
America/New_York, then checks GitHub Actions at 09:45. The root entry owns every
workspace; separate entries for `packages/*` would duplicate that work. Bun's text
lockfile is supported, while the old binary `bun.lockb` format is not.

Runtime and development patch/minor updates have separate groups. Bun groups use
explicit package patterns because Dependabot's `dependency-type` grouping is not
documented for Bun. Keep those patterns aligned when adding dependencies. Unmatched
packages and major updates get individual PRs. Bun version updates wait 3 days for
patches, 7 for minors, and 14 for majors; action updates wait 3 days. Actions security
updates have their own group and do not wait for the weekly schedule or cooldown.

Keep exact manifest versions and full-SHA action pins. Dependabot PRs use `chore`
commit prefixes and do not tag, publish, or merge themselves. Review release notes
and lockfile changes, then require the existing Linux/Windows `check` jobs and the
new `dependency-review` job before merging. Configure those checks as required in
the repository's main-branch ruleset; workflow files alone do not enforce a merge
restriction.

Dependency review rejects newly introduced high/critical advisories reported by
GitHub's dependency graph across runtime, development, and unknown scopes. It runs
with read-only permissions and adds no PR comments. Its coverage follows the
manifests and lockfiles GitHub's graph recognizes; do not assume full Bun transitive
coverage from a green check. GitHub currently supports Bun version updates but
does **not** support automatic Bun security updates. Run `bun audit --audit-level=high`
while reviewing dependency PRs, triage the complete lockfile report, and update
vulnerable dependencies explicitly. Existing advisories need remediation; the audit
is not a blanket blocking CI gate. Enable repository security alerts and automatic
security updates for the ecosystems GitHub supports.

The Bun runtime version is pinned in `packageManager` and workflow `bun-version`
inputs, with matching `@types/bun`. The npm publishing CLI is pinned in `release.yml`.
Dependabot's package and action updates do not keep these executable version inputs
in sync: review them together during runtime upgrades. Dependency changes ship only
through the conventional release and direct npm publishing process above.

Reference: GitHub's [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference),
[supported ecosystems](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories),
and [dependency review action](https://github.com/actions/dependency-review-action).
