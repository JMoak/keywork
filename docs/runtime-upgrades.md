# Shared-engine upgrades

Keywork and Stead use one shared engine. Each installed product records the exact engine
version and contract it requires. Open app windows also hold short-lived leases.
An engine update cannot replace a runtime still required by another installed product,
an active client, or authorized background work.

Installing incompatible app updates one at a time does not migrate those registrations.
Use matching releases until a coordinated upgrade is available. The procedure below is
advanced maintenance with an intentional interruption of background work; it is not the
normal desktop update flow. The current implementation does not provide an automatic
coordinated upgrade of both products.

Both products must carry the same verified engine artifact. A different binary under the
same engine version and contract is refused even after removing every consumer. Such a
build needs a distinct engine release version, or the original matching binary.

## Before maintenance

Obtain both compatible installers and keep a working `keywork` CLI available outside the
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

## Install the compatible pair and restore service

Install both matching releases. Launch the first and enable background work; with the old
requirements removed and no served workspaces, it can register the new engine. Launch
the second; it must accept the same engine version, contract, and binary contents.

Open the creature home through either app, then reopen the recorded projects through the
apps or the workspace controls. The private home must be opened as the managed home,
not added as an ordinary project. Reopening restores serving over the existing files.
Confirm the expected creatures, memory, history, and project bindings before resuming
chores. Review interrupted work before resubmitting it; the upgrade does not replay a
partially completed task on your behalf.
