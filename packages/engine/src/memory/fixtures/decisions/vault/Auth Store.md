---
provenance: "agent"
created: "2026-09-10T09:00:00.000Z"
---
Provider credentials live in the OS credential store as provider.<name>; ~/.keywork/auth.json keeps only the name unless secretStore is plaintext. packages/cli/src/auth-store.ts owns both.
