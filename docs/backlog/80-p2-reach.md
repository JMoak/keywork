# P2 — Reach (post-v1; coarser by design)

> Built after v1 ships; listed so the v1 event vocabulary (A5) and pane registry (C11) are
> designed with these in mind. Tasks here are honestly bigger than 3pt — they'll be split
> when P2 planning starts.

---

### P2.1 (5pt) — HTTP/SSE server wrap
Wrap the A4 bus in a Bun HTTP server: OpenAPI 3.1 spec served at `/doc`, REST for commands,
SSE for the event stream; localhost + token auth by default. Mechanical if A5 held its
SSE-shape promise — this task is the test of D7.
**Strategy:** `LIFT:opencode` `packages/server` patterns.

### P2.2 (3pt) — `keywork attach`
Thin client mounting any registered pane type over the server (`keywork attach --pane diff`);
this is the tmux/zellij composition story from the Q6 synthesis — same components, second
mounting surface.
**Strategy:** `OWN` on C11's registry.

### P2.3 (5pt) — Shared workspaces
Same `--cwd` ⇒ implicit workspace join with live session mirroring across clients; local
socket/Bun IPC discovery; concurrent-access story for the B1 store decided here (index or
sqlite sidecar per D8).
**Strategy:** `OWN` — own design, protocol, and storage.

### P2.4 (2pt) — Notifications
Formula decided (Jordan, 2026-08-10 — see [`../design-language.md`](../design-language.md)):
**needs-you only** — exactly two triggers, both when unfocused: an agent blocked on a
decision (ask-gate, protected-core proposal) and the review inbox crossing its threshold.
Completions/failures/milestones stay silent (dock state on return). Transports
(native toast / OSC 777 / bell / off) auto-select per terminal underneath,
policy-configurable — the formula is not a mode enum.
**Accept:** a keywork notification always corresponds to a wanted keystroke (fixture:
completion while unfocused does NOT notify; ask-gate does); transport fallback chain
tested per terminal fixture.
**Strategy:** `OWN` design.

### P2.5 (2pt) — HTML export & sharing
`/export` static HTML of a session branch (self-contained, themed); optional gist upload.
**Strategy:** `LIFT:pi`.
