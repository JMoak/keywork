# Shared-engine upgrades

Keywork and Stead use one shared engine. Contract-aware apps can ship and run independently:
their bundled engine versions may differ while their exact wire contract matches. Each
consumer and client explicitly opts in with `--contract <contract>`, which must match its
bundled bootstrap. The registry retains the bundled version as provenance and records
`compatibility: "contract"` as its admission requirement. A missing compatibility field
continues to mean an exact-version legacy requirement.

The engine artifact itself remains exact and immutable. Its version, contract and SHA-256
identify the executable selected for this account. Different binary contents under the
same version and contract are refused. A distinct build needs a new published version.
An older compatible bundle reuses the selected newer engine; it never downgrades it.

## Compatible app updates and deferred engine activation

`keywork node status --json` advertises `runtimeCompatibility: 1` when the invoked bootstrap
supports this lifecycle. Apps must require that capability before using `--contract`.
An old binary cannot be made contract-aware by changing an installed consumer record.
Update each app to a capability-aware bootstrap and let it register normally; remaining
legacy registrations continue to protect clients that still use exact-version admission.
This is a one-time adoption boundary, not a requirement for matching future app versions.

Normal consumer installation verifies the candidate and the selected artifact, then reuses
a running compatible engine. It does not stop or restart a live service, even when a
snapshot looks idle: a routine or event could begin work immediately afterward. Successful
installation returns the actual selected `runtime`; a newer candidate may also return
`deferred: { version, reason }`. Reasons distinguish a running runtime, active client leases,
legacy or incompatible consumers, and protected work. The app remains usable on the selected
compatible engine. There is no second engine and no background activation queue.

To activate a newer same-contract engine, finish work and close attached apps. Allow up to
30 seconds for disconnected client leases to expire, then explicitly stop the runtime:

```sh
keywork node stop --json
```

Stopping is an intentional interruption, not a drain operation; finish tasks and permission
requests first. It verifies that the supervisor and recorded children have stopped while
preserving product registrations, served-workspace configuration, home, and history. Launch
the updated app, or retry its normal `node consumer install ... --contract <contract>` command.
The stopped activation takes the mutation and supervisor ownership locks and checks the
processes again before selecting the newer artifact. Configured homes and idle creatures
do not require deregistration at this stopped point: they resume under the newer engine.
If a client or service restarts first, activation stays deferred or refuses the race.

Service registration is applied while stopped, with durable activation intent in the runtime
registry. Selection is committed before starting the new executable. A failed or interrupted
handoff blocks client admission until consumer installation repairs it forward. Retry the
same operation; do not delete the registry or restore an older executable after a candidate
may have opened state. Startup verifies the selected executable's checksum and running
version/contract. The updated legacy `node install` command refuses to replace a managed
selection; `node run` permits only its selected, verified artifact. These guarantees apply
to the managed lifecycle, not arbitrary older executables that predate these checks.

Capability 1 also commits to compatible shared lifecycle records and configuration formats.
Wire-contract equality alone is not permission to change storage incompatibly: older
bootstraps still perform lifecycle mutations. A future breaking lifecycle format needs a
new capability or delegation to the selected engine, with an explicit migration policy.

## Different contracts

A different contract still requires the maintenance procedure below. New apps cannot
reinterpret old registrations or share an engine they do not understand. Unlike a compatible
stopped upgrade, this procedure removes incompatible requirements and served workspaces
before the replacement starts. It preserves existing state and does not provide automatic
cross-contract migration or rollback.

## Before maintenance

Obtain installers supporting the target contract and keep a working `keywork` CLI available outside the
app directories you may uninstall. Use a CLI that supports `node consumer` and
`node workspace`. Keep the previous matching installers available until validation ends.

Finish current tasks, including any waiting for your approval. Decide explicitly to
interrupt background chores for the maintenance window. Quit both apps completely,
including tray instances, and close attached CLI sessions. Wait at least 30 seconds for
crashed or disconnected client leases to expire. Do not relaunch an old app during these
steps: startup would register its old requirement again.

Record the served workspaces before changing anything:

```sh
keywork node workspace list --json
keywork node status --json
```

Save each workspace's `cwd`, optional `slug`, and `home` flag. Also retain the existing
`.keywork` state and your project folders. This procedure does not delete the private
home, creatures, session journals, project bindings, memory, permissions, or history.

## Stop serving the recorded workspaces

Finishing tasks alone is insufficient: a workspace containing a creature keeps the
runtime available, and an offline configured workspace is conservatively retained.
Explicitly remove every recorded workspace from the node's served list:

```sh
keywork node workspace remove "/absolute/path/from/cwd"
keywork node workspace remove "/absolute/project/path" --workspace "recorded-slug"
```

Use the second form only when that row has a non-null slug. Include the private home row,
whose folder is `<user profile>/.keywork/home`; it has no workspace slug. On Windows, the
home command in PowerShell is:

```powershell
keywork node workspace remove "$env:USERPROFILE/.keywork/home"
```

These commands stop serving a workspace and preserve its files. They are an explicit
request to interrupt its background activity. Run `keywork node workspace list --json`
again and confirm that `workspaces` is empty. If the node is running, also wait until
`keywork node status --json` reports no workspace children. Do not proceed while another
client is reopening a workspace.

`keywork node uninstall` alone is insufficient: it preserves the served-workspace
configuration, so the replacement engine would still refuse the upgrade.

## Remove the old product registrations

A full Windows app uninstall invokes its product-scoped removal hook. An in-place app
update skips that hook. Alternatively, remove each registration explicitly before
installing the new pair. Each app stores its installation ID as plain text in
`runtime-consumer.id` inside its own user-data directory. Pass that file's trimmed value
as `--installation`, without adding the product prefix:

```sh
keywork node consumer remove --product keywork --installation "KEYWORK_INSTALLATION_ID" --json
keywork node consumer remove --product stead --installation "STEAD_INSTALLATION_ID" --json
```

For the standard Windows user-data locations, PowerShell can read those values directly:

```powershell
$keyworkInstallation = (Get-Content -LiteralPath "$env:APPDATA/keywork/runtime-consumer.id" -Raw).Trim()
$steadInstallation = (Get-Content -LiteralPath "$env:APPDATA/stead/runtime-consumer.id" -Raw).Trim()
keywork node consumer remove --product keywork --installation $keyworkInstallation --json
keywork node consumer remove --product stead --installation $steadInstallation --json
```

Only remove products actually installed for this account. Multiple installations require
their own IDs. On macOS and Linux, use each app's actual user-data directory and the same
CLI commands; this candidate's automated uninstall hook is Windows-specific.

The first removal normally reports `retained` because another consumer remains. The final
idle removal reports `removed`. `absent` means that exact product/ID was not registered;
check the ID rather than deleting runtime files. If the result remains `retained`, its
`reasons` identify consumers, clients, or work still holding the runtime. Resolve those
requirements before continuing. Ordinary app uninstall deliberately keeps authorized
work running.

Never delete `runtime.sqlite`, the managed engine directory, or `.keywork` to bypass an
admission refusal. Those files are not a substitute for the maintenance steps.

## Install compatible products and restore service

Install products supporting the target contract. Launch the first and enable background work; with the old
requirements removed and no served workspaces, it can register the new engine. Launch
the second; a contract-aware release accepts the selected engine's contract even when its
own bundle has a different version. Legacy products still require an exact matching engine.

Open the creature home through either app, then reopen the recorded projects through the
apps or the workspace controls. The private home must be opened as the managed home,
not added as an ordinary project. Reopening restores serving over the existing files.
Confirm the expected creatures, memory, history, and project bindings before resuming
chores. Review interrupted work before resubmitting it; the upgrade does not replay a
partially completed task on your behalf.
