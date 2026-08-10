# P2 — Reach (post-v1; coarser by design)

> Built after v1 ships; listed so the v1 event vocabulary (A5) and pane registry (C11) are
> designed with these in mind. Tasks here are honestly bigger than 3pt — they'll be split
> when P2 planning starts.

---

## External-surface posture (Jordan, 2026-08-10)

How keywork meets every tool that isn't keywork — decided while examining dictation
(Wispr Flow) support, then generalized to a citizenship ladder. Baseline finding:
dictation already works by construction — OS-level injection arrives as keystrokes or
paste, and WP-5's paste seam made injected newlines literal — so these decisions make
the class first-class rather than accidental:

- **Tier 0 — keyboard citizens** (dictation, text expanders, clipboard managers,
  password managers): no integration surface; the contract is input robustness —
  bracketed paste never submits, bursts render without stutter, no timing-sensitive
  chords anywhere, and a burst arriving while the leader is armed falls through as
  text (Track Q semantics). Wispr Flow is the named flagship; C34 is the fixture.
- **Tier 1 — stream citizens** (scripts, CI, other agents): `keywork run --json`
  (A13) — already shipped.
- **Tier 2 — pane citizens** (LLM interaction windows, voice assistants, overlays):
  P2.1's server + P2.2's attach; external prompt injection is P2.6. Anything wanting
  a live conversation mounts a pane or drives the SSE surface — never a bespoke
  per-tool integration.
- **Voice capture stays external, permanently.** Terminals have no audio surface and
  that is also the correct trust boundary: keywork is a great citizen to injectors;
  it never hosts a microphone.
- **Native-shell revisit gate (D10 restated).** A native app is a *third mounting
  surface* over the D7 server — a Tauri-class shell embedding the TUI, or panes
  rendered natively from SSE — never a port, and it is not considered before the M2
  public demo *and* P2.1 have both landed. Until then, native presence ships as
  G3's desktop entries (Windows Terminal fragment, `.desktop`, macOS `.app` shim).

### C34 (1pt, v1-timed) — Injection citizenship fixture
Probe-harness fixture simulating dictation-class input: a multi-hundred-event burst,
paste with embedded newlines (never submits), burst-during-armed-leader falling
through as text, grapheme-heavy content (emoji/ZWJ/CJK) landing intact.
**Accept:** fixture green in CI; paste/burst regressions fail here first.
**Strategy:** `OWN` on WP-5's `Pane.handlePaste`/`probe.paste()` seams.

### P2.6 (2pt) — External prompt injection
Server endpoint submitting text into a session from outside — the Tier-2 door for
LLM interaction windows and voice assistants: provenance-tagged external per J's
taint boundary, policy-gated per J6, echoed on the bus so every pane sees it as an
ordinary prompt.
**Accept:** injected prompt renders and runs identically to a typed one; any memory
write it causes carries external provenance; unauthorized client rejected.
**Strategy:** `OWN` on P2.1.

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
