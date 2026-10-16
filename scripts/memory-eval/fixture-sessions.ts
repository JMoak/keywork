import { join } from "node:path";
import { repoRoot } from "../lib/repo-files.ts";
import { corpusFiles, fixtureCorpusDir } from "./corpus.ts";
import { recordSession, type SessionScript } from "./recorder.ts";

export const fixtureSessions: readonly SessionScript[] = [
  {
    name: "gate-and-lint",
    steps: [
      {
        prompt: "fix the lint errors in compose.ts",
        replies: [
          { call: "edit", args: { path: "packages/cli/src/compose.ts", old: "import a", new: "" } },
          { call: "bash", args: { command: "bun run lint" } },
          { say: "Lint is clean; [[Biome Lint]] sorts imports, so I let it fix the order." },
        ],
      },
      {
        prompt: "run the gate",
        replies: [
          { call: "bash", args: { command: "bun run lint" } },
          { call: "bash", args: { command: "bun run check && bun run test" } },
          { say: "The gate passes: check and vitest are green, as [[Test Gate]] requires." },
        ],
      },
      {
        prompt: "the soak should run nightly",
        replies: [
          {
            call: "edit",
            args: { path: ".github/workflows/soak.yml", old: "push", new: "schedule" },
          },
          { say: "The soak workflow now runs on a nightly schedule." },
        ],
      },
    ],
  },
  {
    name: "release",
    steps: [
      {
        prompt: "cut the 0.0.2 release",
        replies: [
          { call: "bash", args: { command: "git tag v0.0.2 && git push --tags" }, deny: true },
          {
            say: "I won't push tags: per [[Commit Policy]] you push, and the release workflow tags main.",
          },
        ],
      },
      {
        prompt: "make the release build also pack npm",
        replies: [
          { call: "edit", args: { path: "scripts/release/build.ts", old: "binary", new: "npm" } },
          { call: "memory_get", args: { note: "Release Pipeline" } },
          {
            say: "Done; the build now matches [[Release Pipeline]]: the workflow tags after the gate.",
          },
        ],
      },
      {
        prompt: "pin the new packing dependency",
        replies: [
          { call: "edit", args: { path: "package.json", old: '"devDependencies"', new: "" } },
          { say: "Pinned to an exact version per [[Exact Pins]]." },
        ],
      },
    ],
  },
  {
    name: "decider",
    steps: [
      {
        prompt: "add the memory eval script",
        replies: [
          {
            call: "write",
            args: { path: "scripts/memory-eval.ts", content: "#!/usr/bin/env bun" },
          },
          { call: "memory_get", args: { note: "Decider Port" } },
          { call: "bash", args: { command: "bun run check:pins" } },
          { say: "The script runs any decider through the port and adds no dependency." },
        ],
      },
      {
        prompt: "wire the decider into point-of-action",
        replies: [
          {
            call: "edit",
            args: { path: "packages/engine/src/memory/point-of-action.ts", old: "x", new: "y" },
          },
          {
            call: "edit",
            args: { path: "packages/engine/src/memory/decider.ts", old: "x", new: "y" },
          },
          { say: "Wired as [[Decider Port]] describes; each decision goes on the bus." },
        ],
      },
      {
        prompt: "log what changed in today's daily note",
        replies: [
          {
            call: "write",
            args: { path: ".keywork/memory/daily/2026-10-15.md", content: "- wired" },
          },
          { say: "Logged under daily/, where [[Memory Vault Layout]] puts daily logs." },
        ],
      },
    ],
  },
  {
    name: "events",
    steps: [
      {
        prompt: "add a memory.decided event",
        replies: [
          { call: "edit", args: { path: "packages/engine/src/bus.ts", old: "x", new: "y" } },
          { call: "edit", args: { path: "docs/events.md", old: "x", new: "y" } },
          { call: "bash", args: { command: "bun run contract:fixtures" } },
          {
            say: "Added per [[Event Bus]] and regenerated both fixtures as [[Contract Fixtures]] says.",
          },
        ],
      },
      { compact: "Added memory.decided to the bus and docs, regenerated the contract fixtures." },
      {
        prompt: "bump the contract version",
        replies: [
          {
            call: "edit",
            args: { path: "packages/server/src/contract.ts", old: "1.1", new: "1.2" },
          },
          { say: "Bumped contractVersion from 1.1 to 1.2." },
        ],
      },
      {
        prompt: "run the server tests",
        replies: [
          { call: "bash", args: { command: "bun run test packages/server" } },
          { say: "Server tests pass." },
        ],
      },
    ],
  },
  {
    name: "credentials",
    steps: [
      {
        prompt: "store the TypeSafe key like the other providers",
        replies: [
          { call: "edit", args: { path: "packages/cli/src/auth-store.ts", old: "x", new: "y" } },
          {
            call: "edit",
            args: { path: "packages/cli/src/inference/builtins.ts", old: "x", new: "y" },
          },
          { say: "Stored as provider.typesafe in the OS store, as [[Auth Store]] describes." },
        ],
      },
      {
        prompt: "make sure the anthropic provider still passes review",
        replies: [
          {
            call: "bash",
            args: { command: "bun run test packages/engine/src/providers/anthropic.test.ts" },
          },
          {
            say: "Tests pass and I re-ran the checklist, as [[Anthropic Provider]] requires for any change there.",
          },
        ],
      },
      {
        prompt: "raise the bash timeout for long installs",
        replies: [
          {
            call: "edit",
            args: { path: "packages/engine/src/tools/bash.ts", old: "120_000", new: "600_000" },
          },
          { say: "Raised; [[Command Timeout]] already says ten minutes, so the note now holds." },
        ],
      },
    ],
  },
  {
    name: "sessions-and-prose",
    steps: [
      {
        prompt: "fix the session reader",
        replies: [
          {
            call: "edit",
            args: { path: "packages/engine/src/session/store.ts", old: "x", new: "y" },
          },
          { say: "Fixed; entries chain by parentId as [[Session Files]] says." },
        ],
      },
      {
        prompt: "write the memory eval README",
        replies: [
          { call: "write", args: { path: "docs/memory-eval/README.md", content: "# Memory eval" } },
          { call: "bash", args: { command: "bun run check:prose" } },
          { say: "Written with no em dash anywhere, per [[Em Dash Ban]]; check:prose is clean." },
        ],
      },
      {
        prompt: "color the decisions lens",
        replies: [
          {
            call: "edit",
            args: { path: "packages/tui/src/theme/tokens.ts", old: "x", new: "y" },
          },
          { say: "Added a token for decided rows; no hard-coded colors, per [[Theme Tokens]]." },
        ],
      },
    ],
  },
];

export async function recordFixtureSessions(
  corpusDir = join(repoRoot, fixtureCorpusDir),
): Promise<string[]> {
  const files: string[] = [];
  for (const script of fixtureSessions) {
    const file = join(corpusDir, corpusFiles.sessions, `${script.name}.jsonl`);
    await recordSession(script, { vault: join(corpusDir, corpusFiles.vault), file });
    files.push(file);
  }
  return files;
}

if (import.meta.main) {
  for (const file of await recordFixtureSessions()) console.log(`recorded ${file}`);
}
