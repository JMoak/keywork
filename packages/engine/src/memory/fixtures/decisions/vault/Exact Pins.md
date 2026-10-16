---
provenance: "user"
created: "2026-08-05T09:00:00.000Z"
---
Every dependency in a package.json is pinned to an exact version. scripts/check-pins.ts fails the build on a range such as ^1.2.0 or ~1.2.0.
