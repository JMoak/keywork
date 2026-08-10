# keywork — Design Language (visual vocabulary of record)

> Decided by Jordan, 2026-08-10. This is the one system every surface speaks — memory
> pane (95/J9), MCP status dock (D14), staging/airlock (95/J11), notifications (G6/P2.4),
> status line (C18), permission presets (E2). Placeholder glyphs in earlier planning docs
> (`●◐○ ◇ M+ S±`) are superseded by this direction; exact characters below are the
> working set, refined in implementation against real terminal fonts.

## The material: density

One ramp carries every meaning — `░ ▒ ▓ █` — state as *texture*, not icons. Terminal-
native (block elements render everywhere), theme-token colored, legible at one cell.
This is the "terminal video game" identity: ink density is the signal.

| Surface | Mapping |
|---|---|
| Curing (memory freshness) | `░` fresh → `▒` → `▓` → `█` settled; the garden literally gains ink as knowledge settles |
| Provenance | `█` user-stated · `▓` agent-inferred · `░` external/untrusted — denser = closer to you |
| Staging | `░` prefix + count (`░3` in the status line): staged items are low-density by definition |
| MCP server state (D14) | `█` connected · `▒` connecting · `░` down; per-server one-cell mark |
| Loading (all progress) | density fills: `░░▒▓█` |
| Notification badge | needs-you is the *only* notifying state (see formula) — rendered full-density, everything else stays quiet |

Rules: color is the second axis, never the only one (`NO_COLOR`/colorblind-safe by
construction — density survives monochrome); both light and dark themes map density to
contrast against the pane ground (C17 tokens); reduced-motion honored — animations
degrade to stepped density changes.

## The signature animation: tile-fill

Progress marks are **the dwindle layout in miniature** — a one-cell rectangle splits and
fills as phases complete, the tiler's own geometry as its smallest animation:

```
connecting   ▌  →  ▌▀  →  ▌▀▗  →  █      ready: █ (holds)
failed       ▛ (a tile missing — the gap is the message)
```

Determinate when phases are known (MCP handshake → tools listed → ready); a gentle
split-cycle when not. Reused everywhere something works: D14 connections, Gardener
sweeps, index rebuilds, embedding warmup. Never a spinner.

## The notification formula: needs-you only

A keywork notification always means **a keystroke is wanted**. Exactly two triggers,
both derived from work state, both when the workspace is unfocused:

1. An agent is blocked on a decision (ask-gate prompt, protected-core proposal).
2. The review inbox crossed its configured threshold (95/P3's long-session door).

Completions, failures, milestones: silent — they're dock/status state you see on return.
Transports (native toast / OSC 777 / bell / off) auto-select per terminal underneath and
are policy-configurable; the *formula* is not a mode enum.

## The status line grammar (C18)

`keywork · <model> · <preset-word> · ░n` — the E2 permission preset as a plain lowercase
word (policy-file bundle names, Jordan's naming call; divergence renders `custom`), the
staging count in ramp texture, token/cost per A15. Every item justified or absent.

## Ledger chips

Session-ledger durable-write chips stay textual (`+mem ±skill ±cfg` styling to be
refined) with density prefix carrying provenance — e.g. `░+mem` = staged memory write
from an untrusted turn.
