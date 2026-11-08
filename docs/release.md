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
release and staged on npm only for a release tag when the repository variable
`NPM_PUBLISH` is `true`. Staging uses GitHub Actions trusted publishing with OIDC;
the workflow uses no npm token. A maintainer approves the staged package separately.

## The ritual

1. Bump `version` in `packages/cli/package.json` (the root and the other workspaces can
   stay at their own numbers; the CLI manifest is the release version).
2. Commit, then tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. `release.yml` runs: build matrix → checksums → GitHub Release (created with `gh`, notes
   generated) → a timed `scripts/install.sh` against the just-published tag, printed in the
   job log as the install-to-`--version` measurement.
4. Read that number. Install is one leg of the 60 seconds; onboarding, first turn, and
   first undo are the others and are timed by hand for the screencast.

The build refuses a tag that does not match the manifest (`--expect-tag`), so a stale
`package.json` can never ship under a newer tag.

The manifest version is also `info.version` in `keywork serve`'s `GET /doc`. The server
contract has its own number beside it (`info.x-keywork-contract`, from
`packages/server/src/contract.ts`), and a release that changed a route or an event bumps
that one too; [`events.md`](events.md) says when a minor and when a major, and
`bun run contract:fixtures` regenerates the two fixtures whose diff is the review.

## Locally

```sh
bun run build:binary          # dist/release/<host asset> + .sha256, smoke-tested
bun run build:npm             # dist/npm/, smoke-tested with `bun dist/npm/bin/keywork.js --version`
bun scripts/release/build.ts --outdir /tmp/out --version 0.0.0-local
```

`keywork --version` prints the build-time version in a release binary and the manifest
version when run from source.

## npm trusted staging

The generated package is `keywork-cli@0.2.0`, with `bin.keywork` pointing at
`bin/keywork.js`, the canonical repository `git+https://github.com/JMoak/keywork.git`,
and public access on `https://registry.npmjs.org`. Ratchet is carried inside the bundle;
OpenTUI and web-tree-sitter remain exact public dependencies. The allowlist also includes
the license, notices, README, and shared-runtime upgrade guide.

Before the first staging run, the package owner configures these settings; the workflow
does not create or verify them locally:

- On npm's **keywork-cli** package, add a GitHub Actions trusted publisher with organization
  or user **JMoak**, repository **keywork**, workflow filename **release.yml**, and no
  environment name. Those fields are case-sensitive. Allow `npm stage publish`; direct
  publishing and dist-tag management are not needed by this workflow.
- In **JMoak/keywork**, set the Actions repository variable **NPM_PUBLISH** to **true**.
  An unset or different value intentionally skips `npm-publish`.

The staging job runs on a GitHub-hosted Ubuntu runner with Node 24 and npm 12.2.2. It
has `id-token: write`, uses no token environment variable or token-placeholder `.npmrc`,
and retains all existing check, test, end-to-end, platform build, checksum, and GitHub
release gates. It verifies the package name, repository, public status, and agreement
between the package version and release tag, then inspects the pack list before running:

```sh
npm stage publish --access public --tag latest --loglevel verbose
```

GitHub OIDC generates provenance automatically for a public package from a public
repository; there is no local provenance claim before that CI run. The npm
[trusted-publishing guide](https://docs.npmjs.com/trusted-publishers/) describes the
required configuration and provenance conditions.

After staging, the owner reviews the stage ID, package contents, version, tag, and source
workflow on npm. Approval uses 2FA through npm's Staged Packages page or
`npm stage approve <stage-id>`; the release workflow does not approve its own package.
Staged versions are not visible through ordinary `npm view`, and staging the same version
again can conflict with the pending stage. Review or reject that stage before rerunning.
See npm's [staged-publishing guide](https://docs.npmjs.com/staged-publishing/).

Local preparation uses `bun run build:npm` and `npm pack --dry-run` from `dist/npm`.
Neither command uploads, stages, approves, or publishes a package. The build checks the
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
inputs, with matching `@types/bun`. The npm staging CLI is pinned in `release.yml`.
Dependabot's package and action updates do not keep these executable version inputs
in sync: review them together during runtime upgrades. Dependency changes ship only
through the normal tagged release and staged npm approval process above.

Reference: GitHub's [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference),
[supported ecosystems](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories),
and [dependency review action](https://github.com/actions/dependency-review-action).
