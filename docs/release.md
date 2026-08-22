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
`SHA256SUMS`. The npm fallback (`dist/npm`, package `keywork`, `bin` = the bundled CLI that
runs on an installed Bun with `@opentui/core` as a normal dependency) is built on every
release and published only when the repository variable `NPM_PUBLISH` is `true` and an
`NPM_TOKEN` secret exists.

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

## Locally

```sh
bun run build:binary          # dist/release/<host asset> + .sha256, smoke-tested
bun run build:npm             # dist/npm/, smoke-tested with `bun dist/npm/bin/keywork.js --version`
bun scripts/release/build.ts --outdir /tmp/out --version 0.0.0-local
```

`keywork --version` prints the build-time version in a release binary and the manifest
version when run from source.

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
