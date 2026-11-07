# The stead workshop kit for Docker Sandboxes (`sbx`)

A creature's workshop is one `sbx` microVM grown from this kit. The node drives it through
`packages/engine/src/workshop/sbx.ts`; nothing here is run by hand in normal use.

| File | What it is |
|---|---|
| `spec.yaml` | The kit, schema version 2, in JSON syntax (a YAML subset), so tests read it with `JSON.parse`. |

## What the kit gives a workshop

- **The VM.** A digest-pinned `docker/sandbox-templates` shell image passed as
  `--kit-arg image=...`. The qualified digest lives beside the pinned `sbx` version in
  `qualifiedTemplate` and `qualifiedSbxVersion` (`packages/engine/src/workshop/sbx.ts`).
- **No credentials.** The kit declares none. The node hands each model-provider credential the
  creature is granted to `sbx secret set-custom --sandbox <name> --value-stdin`, so the value
  travels on stdin to the host proxy and never sits in an argument, a file in the VM, or the
  VM's environment. Inside, the variable holds Docker's `sbx-cs-...` placeholder and the host
  proxy swaps the real value into request headers on the way out (RUN-003).
- **Setup-only network.** `permissions.network.allow` names the Ubuntu mirrors the setup step
  needs to install Xvfb and ImageMagick. Kit allow rules stay allowed at runtime, so right after
  creation the node adds a per-sandbox deny for each of them (a sandbox deny overrides a kit
  allow). The creature then reaches only the hosts its spec names plus its brokers' API hosts.
- **The display.** `stead-display snapshot` starts Xvfb on `:99` with `-nolisten tcp` (no network
  listener at all, only the local socket) and prints one PNG of the screen, scaled to at most
  1024x768 (RUN-023), as base64. It exits 3 when Xvfb or ImageMagick is absent, which the node
  reads as "no display".

## Egress from deny-all

The node expects the host's `sbx` policy to be **Locked Down** (`deny-all`). It reads
`sbx policy ls`, and every allow rule that would reach this sandbox but is not the creature's own
(a Balanced preset's wildcards, a kit allow) gets a per-sandbox deny. When an inherited wildcard
covers a host the creature does want, a deny would also block that host, so the node refuses to
create the workshop and names the global rule to remove instead of narrowing it silently.

## Pins and what is never scripted

- `sbx` is pinned to an exact qualified version. A different version is refused until it is
  qualified and the pin moves; a version older than one the node has already seen is refused as
  a downgrade (RUN-010).
- `sbx reset` deletes every sandbox and is refused by the adapter's command guard.

## Not qualified yet

Neither Docker nor `sbx` was installed where this kit was written. `sbx kit validate`, a real
boot, the setup install, the display snapshot, `secret set-custom` injection and the effective
policy are live qualification steps tracked as a follow-up to work item `wi-gktz`. The adapter's
tests replay a transcript shaped from the Docker Sandboxes documentation instead.
