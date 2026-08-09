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
**Strategy:** `REIMPL:crush` idea — own protocol, own storage.

### P2.4 (2pt) — Notifications
"Come back, I need a decision" as a designed moment: native (Windows toast) / OSC 777 / bell
/ off modes, fired on ask-gate prompts and turn completion when unfocused.
**Strategy:** `REIMPL:crush` modes idea.

### P2.5 (2pt) — HTML export & sharing
`/export` static HTML of a session branch (self-contained, themed); optional gist upload.
**Strategy:** `LIFT:pi`.
