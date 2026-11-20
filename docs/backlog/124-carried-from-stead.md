# Carried over from Stead

> Capture, not authoritative. These were recorded as work items in the Stead repository while
> Keywork's source was nested there. Stead removed those records on 2026-11-19, and this file is
> where the ones that belong to Keywork landed. Nothing here has been checked against the current
> code: "open" and "to verify" are what could be established from the records. When an item is
> taken up, move it into the overlay that owns its topic and delete it from here. Ids such as `wi-42cx` are the names
> of the removed Stead items.

## Open when recorded

### Cut redundant git launches around a checkpoint, cached diffs and one snapshot per restore (`wi-gvks`)

Reduce redundant git process launches around Keywork checkpoints (cache diffs by tree pair, one snapshot per restore) and close idle shells faster on Windows.

Recorded status: draft; no handoff; canonical keywork packages/engine/src/checkpoints.ts still calls diff-tree directly with no tree-pair cache

### Have node status issue a fresh claim code when none is live, instead of asking for a restart (`wi-ncpy`)

Have keywork node status issue a fresh pairing claim code when none is live instead of requiring a node restart.

Recorded status: draft; canonical keywork cli/src/node/status.ts still prints no claim code is live (a headless node prints one when it starts)

### Memory's decider rides the engine's Decider port: one deciderFor, no second DeciderName (`wi-pnhr`)

Make memory's decider use the engine's Decider port with one deciderFor and no second DeciderName.

Recorded status: draft with stub context; canonical keywork engine/src/memory/decider.ts still defines its own DeciderName

## To verify

Completion could not be confirmed. Tick each one that is done; treat the rest as open.

- [ ] **The idle node costs 1.3 percent of a core (core 0.61, serve 0.68) and spawns tailscale status every 15 s on Windows** (Stead `wi-2xu8`): Cut the always-on node's idle CPU (about 1.3 percent of a core) and stop it spawning `tailscale status` every 15 seconds on Windows, with an idle budget pinned by a fake-clock test. _Why unknown: no handoff; listed as open in docs/plan-milestone-three.md wave 9; canonical keywork still polls on a fixed 15 s activity timer (not proof the defect remains)_
- [ ] **The node serves the folders the keeper opens: node workspace add, remove and list, the console hands folders to it** (Stead `wi-4gjm`): Let the always-on node serve folders the keeper opens in the console (node workspace add, remove, list) so chores keep running when the console closes. _Why unknown: handoff partial: pane not reachable without host port wiring (keywork-app side); no later evidence checked_
- [ ] **Integration D leftovers: payload read scope, one-shot cleanup, fixture collapse, decided-for-you porch item** (Stead `wi-4j52`): Finish leftovers from integration point D across engine and console: trigger payload read scope, one-shot chore cleanup, fixture collapse, a decided-for-you porch item. _Why unknown: handoff partial with named leftovers (payload read scope, porch decided-for-you line, cold-start review wiring, fixture copies, live catalogue); spans keywork and keywork-app_
- [ ] **The schedule tool for self-paced wakeups and the file-watch, webhook and event triggers for chores** (Stead `wi-5kw6`): Let a creature schedule its own wakeups and let chores fire on file-watch, webhook and event triggers. _Why unknown: handoff partial: serve wiring, one-shot self-deletion (RUN-034) and expiry fallback wake (RUN-048) not built; wi-4j52 also partial_
- [ ] **Memory: forget-by-source with a dry run, the admission policy for untrusted sources, craft memory in the profile** (Stead `wi-7xmp`): Memory: forget by source with a dry run, an admission policy for untrusted sources, and craft memory shown in the creature profile. _Why unknown: handoff partial: serve wiring, client methods and needs-you staging hookup left; spans keywork and keywork-app_
- [ ] **keywork: changes after a restore still list the undone turn's frozen files** (Stead `wi-y2yu`): Make the changes listing after a restore stop listing the undone turn's files, and pin the event order in fixtures. _Why unknown: accepted, no handoff; not verified against canonical keywork_
- [ ] **Pin that a delegated child inside a chore run inherits the chore's confinement, never more** (Stead `wi-y9s8`): Add a test pinning that a delegated child session inside a chore run inherits the chore's confinement and never more. _Why unknown: draft with stub context; canonical keywork has routines posture and runner tests but inheritance by delegated children not checked_
