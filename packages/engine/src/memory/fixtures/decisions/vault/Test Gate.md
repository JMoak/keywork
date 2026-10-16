---
provenance: "user"
created: "2026-08-03T09:00:00.000Z"
---
The gate is `bun run check && bun run test`. `bun run test` is vitest; bare `bun test` is Bun's own runner and is not the gate.

A task is done only when both are green.
