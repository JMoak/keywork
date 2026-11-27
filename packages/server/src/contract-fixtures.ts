import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Grant, Message, PairRecord, PendingPairing, ToolCallPart } from "@keywork/engine";
import {
  engineEventTypes,
  serverEventTypes,
  type WireEvents,
  type WireEventType,
} from "./events.ts";
import { type OpenApiDocument, openApiDocument } from "./openapi.ts";
import { serializeEnvelope } from "./sse.ts";

export const regenerateCommand = "bun run contract:fixtures";

export const documentFixturePath = fileURLToPath(
  new URL("./openapi-document.fixture.json", import.meta.url),
);

export const eventShapesFixturePath = fileURLToPath(
  new URL("./event-shapes.fixture.json", import.meta.url),
);

export const wireEventTypes: readonly WireEventType[] = [...engineEventTypes, ...serverEventTypes];

export type Shape = string | Shape[] | { [key: string]: Shape };

export interface EventShapes {
  envelope: Shape;
  events: Record<WireEventType, Shape>;
}

export function fixtureDocument(): OpenApiDocument {
  return openApiDocument("http://127.0.0.1:4770", "0.0.0-fixture", {
    anchor: "C:/work/anchor",
    identity: "anchor-identity",
  });
}

export function eventShapes(): EventShapes {
  const events = {} as Record<WireEventType, Shape>;
  for (const type of wireEventTypes) events[type] = single(distinctShapes(wirePayloadsOf(type)));
  return { envelope: envelopeShape(), events };
}

export function writeContractFixtures(): void {
  writeFileSync(documentFixturePath, pretty(fixtureDocument()));
  writeFileSync(eventShapesFixturePath, pretty(eventShapes()));
}

export function shapeOf(value: unknown): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) return distinctShapes(value);
  if (typeof value !== "object") return typeof value;
  const shape: { [key: string]: Shape } = {};
  for (const [key, field] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    shape[key] = key === tagKey && typeof field === "string" ? `'${field}'` : shapeOf(field);
  }
  return shape;
}

const tagKey = "type";

type Samples = { readonly [Type in WireEventType]: readonly WireEvents[Type][] };

const call: ToolCallPart = {
  type: "tool-call",
  callId: "c1",
  name: "bash",
  arguments: { command: "ls" },
};

const message: Message = { role: "assistant", parts: [{ type: "text", text: "done" }, call] };

const pendingPairing: PendingPairing = {
  pairingId: "p1",
  peerStableId: "nHouseA1b2CNTRL",
  peerUserId: "7000000000000001",
  role: "console",
  caps: ["exec"],
  confirmation: "on-device",
  phase: "confirming",
  sas: "482913",
  expiresAt: "2026-11-05T10:05:00.000Z",
};

const pair: PairRecord = {
  id: "pair-1",
  peerStableId: "nHouseA1b2CNTRL",
  peerUserId: "7000000000000001",
  peerTags: [],
  peerDeviceKey: "MCowBQYDK2VwAyEA",
  role: "console",
  caps: ["exec"],
  endpoint: "http://100.101.102.103:47800",
  createdAt: "2026-11-05T10:00:00.000Z",
  confirmedBy: "on-device",
};

const grant: Grant = {
  id: "g1",
  issuer: "nHouseA1b2CNTRL",
  subject: { creature: "pip", node: "nHouseA1b2CNTRL" },
  target: "nHostC3d4CNTRL",
  caps: [{ kind: "exec", commands: ["echo"] }],
  issuedAt: "2026-11-05T10:00:00.000Z",
  expiresAt: "2026-11-06T10:00:00.000Z",
  nonce: "n1",
  signature: "c2ln",
};

const usage = {
  inputTokens: 10,
  outputTokens: 4,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUsd: 0.001,
};

const samples: Samples = {
  "turn.started": [
    { userText: "hi", entryId: "e1", origin: { kind: "external", client: "keywork-app" } },
    { userText: "Fix the failing test.", entryId: "e2", origin: { kind: "keeper" } },
    {
      userText: "The keeper answered the question that waited while the engine was stopped: …",
      entryId: "e3",
      origin: {
        kind: "answer",
        callId: "c1",
        tool: "bash",
        verdict: "denied",
        reason: "other",
        note: "not on this branch",
      },
    },
  ],
  "turn.delta": [
    { delta: { type: "text", text: "hi" } },
    { delta: { type: "visible-thinking", text: "hmm" } },
    {
      delta: {
        type: "redacted-thinking",
        part: {
          type: "redacted-thinking",
          data: "sealed",
          owner: { provider: "anthropic", model: "m" },
        },
      },
    },
    { delta: { type: "tool-call", call: call } },
    { delta: { type: "progress", text: "reading" } },
    {
      delta: {
        type: "done",
        usage,
        responseId: "r1",
        cacheMiss: { cause: "cold", missedTokens: 10 },
      },
    },
  ],
  "turn.completed": [{ message, usage, delivery: "3f9c0a1b2c3d4e5f" }],
  "turn.interrupted": [{ message }],
  "turn.waiting": [{ reason: "rate-limited", until: "2026-11-06T10:00:02.000Z", attempt: 2 }],
  "turn.resumed": [{ attempt: 2 }],
  "queue.changed": [
    {
      queued: [
        { id: "q1", text: "next", behavior: "queue", origin: { kind: "external", client: "app" } },
      ],
    },
  ],
  "tool.started": [{ call: call }],
  "tool.output": [{ chunk: "line\n", callId: "c1" }],
  "tool.finished": [
    {
      callId: "c1",
      output: "ok",
      isError: false,
      spill: { id: "s1", bytes: 4096, elidedFrom: 10, elidedTo: 20 },
      exitCode: 0,
    },
    {
      callId: "c2",
      output:
        "You are brisk now, and settle back to eager by yourself once you have rested a while.",
      isError: false,
      fact: { kind: "temperament", manner: "brisk", favourite: "eager" },
    },
  ],
  "gate.ask": [
    {
      ask: {
        tool: "bash",
        callId: "c1",
        arguments: { command: "git push" },
        rule: "default",
        rules: [{ action: "bash", resource: "git push *", effect: "allow" }],
      },
    },
    {
      ask: {
        tool: "edit",
        callId: "c2",
        arguments: { path: "src/a.ts", oldText: "one", newText: "two" },
        rule: "default",
        rules: [],
        preview: { path: "src/a.ts", before: "one\n", after: "two\n" },
      },
    },
  ],
  "gate.permission": [
    {
      decision: {
        tool: "bash",
        callId: "c1",
        verdict: "granted",
        gate: "user",
        scope: "session",
        asked: true,
      },
    },
    {
      decision: {
        tool: "write",
        callId: "c2",
        verdict: "denied",
        gate: "user",
        asked: true,
        reason: "not-now",
      },
    },
    {
      decision: {
        tool: "write",
        callId: "c4",
        verdict: "denied",
        gate: "user",
        asked: true,
        reason: "other",
        note: "write it under src/, not the root",
      },
    },
    {
      decision: {
        tool: "bash",
        callId: "c3",
        verdict: "granted",
        gate: "quiet",
        scope: "session",
        asked: false,
      },
    },
  ],
  "gate.preset": [{ from: "ask", to: "trusted" }],
  "session.mode": [{ mode: "plan" }],
  "context.injected": [{ injection: { source: "skill", id: "deploy", scope: "workspace" } }],
  "memory.decided": [
    {
      decision: {
        id: "d1",
        question: "action-relevance@1",
        about: { kind: "call", callId: "c1" },
        candidates: ["Auth Tokens", "Old Auth"],
        choice: { kept: ["Auth Tokens"], dropped: ["Old Auth"] },
        decider: "builtin",
        rule: '[[Auth Tokens]] shares "auth" with the path; [[Old Auth]] is superseded',
        latencyMs: 0,
      },
    },
    {
      decision: {
        id: "d2",
        question: "drift-verdict@1",
        about: { kind: "note", note: "Auth Tokens" },
        candidates: ["Auth Tokens"],
        choice: "stale",
        scores: { hold: 0.03, stale: 0.94, unsure: 0.03 },
        confidence: 0.91,
        decider: "jev",
        model: "jev-1.13.0",
        latencyMs: 271,
        inputTokens: 1480,
        stateHash: "9f2c",
      },
    },
    {
      decision: {
        id: "d3",
        question: "action-relevance@1",
        about: { kind: "call", callId: "c1" },
        candidates: ["Auth Tokens", "Deploy Notes"],
        choice: { kept: ["Auth Tokens"], dropped: ["Deploy Notes"] },
        scores: { "Auth Tokens": 0.5, "Deploy Notes": 0.04 },
        decider: "builtin",
        model: "jev-1.13.0",
        rule: '[[Auth Tokens]] shares "auth" with the path',
        fallback: { reason: "undecided", undecided: ["Auth Tokens"] },
        latencyMs: 212,
        waitedMs: 12,
        inputTokens: 900,
      },
    },
  ],
  "child.started": [{ callId: "c1", sessionId: "s2", title: "find the callers", bot: "scout" }],
  "child.finished": [
    {
      callId: "c1",
      sessionId: "s2",
      outcome: "denied",
      usage,
      costNanos: 1200,
      refused: [{ tool: "bash", callId: "c7" }],
    },
  ],
  "diagnostics.published": [{ path: "src/a.ts", count: 2 }],
  "shell.reset": [{ replay: true }],
  "extension.notice": [
    { extension: "hooks", level: "warn", message: "slow hook", detail: { ms: 1200 } },
  ],
  "engine.error": [{ error: new Error("boom") }],
  "memory.inbox": [{ count: 3, staged: 1, airlock: 1, proposals: 1, contradictions: 0 }],
  "session.state": [
    {
      model: "anthropic/claude",
      thinking: true,
      effort: "high",
      title: "first",
      leafId: "e9",
      arc: "launch",
      bot: "reviewer",
      quiet: true,
      undoable: true,
      redoable: false,
    },
  ],
  "surface.changed": [{ kind: "mcp" }],
  "session.tree": [{ reason: "fork", entryId: "e3", forkedTo: "s2" }],
  "changes.updated": [{ paths: ["src/a.ts"], turn: 2 }],
  "session.removed": [{ sessionId: "s1" }],
  "session.restored": [{ sessionId: "s1" }],
  "session.settled": [
    {
      phase: "after-turn",
      flushed: 2,
      compacted: {
        id: "e10",
        parentId: "e9",
        timestamp: "2026-10-12T00:00:00.000Z",
        type: "compaction",
        summary: "folded",
        firstKeptEntryId: "e8",
        tokensBefore: 90000,
        details: { readFiles: ["src/a.ts"], modifiedFiles: [] },
        usage,
      },
      notices: ["compacted 90000 tokens"],
    },
  ],
  "model.fallback": [
    {
      class: "loop",
      from: "ollama/qwen3:8b",
      to: "openrouter/qwen/qwen3-32b",
      trigger: "down",
      cloud: true,
    },
  ],
  "creature.changed": [{ slug: "pip", change: "created" }],
  "creature.handoff": [
    {
      change: "counted",
      handoff: { from: "wren", to: "pip", count: 3, lastAt: "2026-11-05T09:02:00.000Z" },
    },
    {
      change: "dropped",
      handoff: { from: "pip", to: "wren", count: 1, lastAt: "2026-11-05T08:40:00.000Z" },
    },
  ],
  "creature.ledger": [
    {
      creature: "pip",
      change: "opened",
      entry: {
        id: "3f9a0c1d2e4b5a67",
        kind: "question",
        state: "waiting",
        title: "Allow bash git push origin main?",
        directory: "C:/work/anchor",
        session: "s1",
        openedAt: "2026-11-05T09:00:00.000Z",
        closedAt: null,
        answer: null,
        about: { kind: "ask", callId: "c1", tool: "bash" },
        conversation: null,
        project: null,
      },
      folded: 0,
    },
    {
      creature: "pip",
      change: "opened",
      entry: {
        id: "6d8f0b2c4e6a8193",
        kind: "question",
        state: "waiting",
        title: "Allow bash bun test?",
        directory: "C:/work/orchard",
        session: "p1",
        openedAt: "2026-11-05T09:05:00.000Z",
        closedAt: null,
        answer: null,
        about: { kind: "ask", callId: "c7", tool: "bash" },
        conversation: null,
        project: "4e1c0d9a7b23",
      },
      folded: 0,
    },
    {
      creature: "pip",
      change: "changed",
      entry: {
        id: "8b2e4d6f1a3c5e70",
        kind: "question",
        state: "answered",
        title: 'May the chore "Morning triage" write?',
        directory: "C:/work/anchor",
        session: null,
        openedAt: "2026-11-05T08:00:00.000Z",
        closedAt: "2026-11-05T08:30:00.000Z",
        answer: "granted",
        about: { kind: "grants", routineId: "triage" },
        conversation: {
          session: "s5",
          state: "ended",
          openedAt: "2026-11-05T08:10:00.000Z",
          endedAt: "2026-11-05T08:30:00.000Z",
          endedBy: "answer",
        },
        project: null,
      },
      folded: 0,
    },
    {
      creature: "pip",
      change: "changed",
      entry: {
        id: "5c7e9a1b3d5f7092",
        kind: "task",
        state: "finished",
        title: "Morning triage",
        directory: "C:/work/anchor",
        session: "s2",
        openedAt: "2026-11-05T08:30:00.000Z",
        closedAt: "2026-11-05T08:34:00.000Z",
        answer: null,
        about: { kind: "chore", routineId: "triage", runId: "pip:triage:1762329600000:1" },
        conversation: null,
        project: null,
      },
      folded: 0,
    },
    {
      creature: "pip",
      change: "folded",
      entry: {
        id: "1a2b3c4d5e6f7081",
        kind: "task",
        state: "blocked",
        title: "Sort the inbox",
        directory: "C:/work/anchor",
        session: null,
        openedAt: "2026-11-01T10:00:00.000Z",
        closedAt: "2026-11-01T10:05:00.000Z",
        answer: null,
        about: { kind: "thread" },
        conversation: null,
        project: null,
      },
      folded: 1,
    },
  ],
  "creature.deliveries": [
    {
      change: "delivered",
      delivery: {
        id: "9c1e4a7b2d3f5a60",
        creature: "osk",
        line: "The garden notes are written.",
        title: null,
        files: [{ path: "notes/garden.md", added: 3, deleted: 0 }],
        at: "2026-11-05T09:06:00.000Z",
        directory: "C:/Users/keeper/.keywork/home",
        session: "f2c1a7d0-1111-4c3b-9d4e-5a6b7c8d9e0f",
        project: null,
        about: { kind: "conversation" },
        openedAt: null,
      },
      folded: 0,
    },
    {
      change: "opened",
      delivery: {
        id: "2b7d9e1f4a6c8053",
        creature: "wren",
        line: "Three issues are new since yesterday.",
        title: "Morning triage",
        files: [],
        at: "2026-11-05T08:01:12.000Z",
        directory: "C:/Users/keeper/.keywork/home",
        session: "s3",
        project: null,
        about: { kind: "chore", routineId: "triage", runId: "wren:triage:1762329600000:1" },
        openedAt: "2026-11-05T09:30:00.000Z",
      },
      folded: 4,
    },
    {
      change: "folded",
      delivery: {
        id: "4e6a8c0b2d1f3e57",
        creature: "osk",
        line: "a.txt holds its own name.",
        title: "Write a.txt with its own name in it.",
        files: [{ path: "a.txt", added: 1, deleted: 0 }],
        at: "2026-11-01T10:05:00.000Z",
        directory: "C:/work/tally",
        session: null,
        project: "4e1c0d9a7b23",
        about: { kind: "thread" },
        openedAt: "2026-11-01T11:00:00.000Z",
      },
      folded: 51,
    },
  ],
  "creature.worksites": [
    {
      change: "changed",
      worksite: {
        creature: "pip",
        directory: "C:/work/anchor/garden",
        root: "C:/work/anchor",
        project: null,
        conversations: 2,
        since: "2026-11-05T08:00:00.000Z",
        latest: "2026-11-05T09:02:00.000Z",
        active: true,
      },
    },
    {
      change: "dropped",
      worksite: {
        creature: "wren",
        directory: "C:/work/orchard",
        root: "C:/work/orchard",
        project: "9c1d2e3f4a5b",
        conversations: 1,
        since: "2026-11-04T10:00:00.000Z",
        latest: "2026-11-04T10:00:00.000Z",
        active: false,
      },
    },
  ],
  "creature.honours": [
    {
      change: "earned",
      honour: {
        holder: "pip",
        kind: "partners",
        tier: 1,
        with: "wren",
        earnedAt: "2026-11-05T09:02:00.000Z",
        proof: "Ten hand-offs with wren, both ways together; the tenth on 5 November 2026.",
      },
    },
    {
      change: "dropped",
      honour: {
        holder: null,
        kind: "first-creature",
        tier: 1,
        with: null,
        earnedAt: "2026-11-01T08:00:00.000Z",
        proof: "The first creature, pip, was made on 1 November 2026.",
      },
    },
  ],
  "creature.scenes": [
    {
      creature: "pip",
      change: "kept",
      scene: {
        creature: "pip",
        name: "Morning review",
        place: { kind: "project", creature: "pip", directory: "C:/work/anchor" },
        holds: [
          { kind: "file", title: "PLAN.md" },
          { kind: "pane", title: "sessions" },
        ],
        keptAt: "2026-11-05T09:02:00.000Z",
      },
    },
    {
      creature: "wren",
      change: "forgotten",
      scene: {
        creature: "wren",
        name: "triage",
        place: null,
        holds: [{ kind: "note", title: "Open questions" }],
        keptAt: "2026-11-04T10:00:00.000Z",
      },
    },
  ],
  "creature.promises": [
    {
      creature: "wren",
      promises: [
        {
          kind: "chores-ran",
          state: "broken",
          checks:
            "Each chore that is on ran when it was due and finished, or its check found nothing to do.",
          evidence: [
            {
              subject: "Morning look",
              checkedAt: "2026-11-05T09:13:00.000Z",
              found:
                "stopped after it kept failing: the run could not start: mill does not answer at http://127.0.0.1:11434; is its model server running?",
              ok: false,
            },
          ],
          repairs: [
            {
              subject: "Morning look",
              startedAt: "2026-11-05T09:00:01.000Z",
              tries: 5,
              bound: 5,
              nextAt: null,
              endedAt: "2026-11-05T09:13:00.000Z",
              outcome: "failed",
            },
          ],
        },
        {
          kind: "models-reachable",
          state: "broken",
          checks: "Each model this creature talks and works on can answer.",
          evidence: [
            {
              subject: "mill/puppet:7b, for talking with you and for its chores",
              checkedAt: "2026-11-05T09:13:00.000Z",
              found: "does not answer at http://127.0.0.1:11434",
              ok: false,
            },
          ],
          repairs: [],
        },
        {
          kind: "workshop-healthy",
          state: "kept",
          checks: "The creature's workshop answers.",
          evidence: [
            {
              subject: "this host",
              checkedAt: "2026-11-05T09:14:00.000Z",
              found: "its workspace folder is there and writable",
              ok: true,
            },
          ],
          repairs: [],
        },
        {
          kind: "gates-valid",
          state: "unknown",
          checks: "Every gate the creature holds is still the one you opened.",
          evidence: [],
          repairs: [],
        },
      ],
      questions: [
        {
          id: "model-3c1f0a9b2d7e",
          creature: "wren",
          promise: "models-reachable",
          sentence: '"Morning look" did not run: Wren\'s model is not answering.',
          address: "http://127.0.0.1:11434",
          lastFailure: null,
          since: "2026-11-05T09:13:00.000Z",
          choices: [
            { id: "retry", label: "Try again" },
            {
              id: "model",
              label: "Choose another model",
              models: [{ provider: "spark", model: "qwen3:32b" }],
            },
            { id: "off", label: "Turn the chore off" },
          ],
          about: {
            chores: ["look"],
            conversation: false,
            model: { provider: "mill", model: "puppet:7b" },
          },
        },
      ],
    },
  ],
  "creature.talking": [
    {
      slug: "osk",
      talking: {
        provider: "mill",
        model: "puppet:7b",
        mode: "chat",
        detail:
          "mill/puppet:7b answered without calling a tool when it was asked to, so it can talk but cannot use tools.",
        projectCheck: { endpoint: "http://127.0.0.1:11434/v1", model: "puppet:7b" },
      },
    },
    { slug: "wren", talking: { provider: "spark", model: "qwen3:32b", mode: "tools" } },
    {
      slug: "pip",
      talking: { refused: "unconfigured", detail: "Choose a starting model for conversation." },
    },
  ],
  "model.wait": [
    {
      change: "waiting",
      wait: {
        session: "f2c1a7d0-1111-4c3b-9d4e-5a6b7c8d9e0f",
        creature: "pip",
        server: "http://127.0.0.1:11434",
        reason: "busy",
        since: "2026-11-05T09:02:00.000Z",
      },
    },
    {
      change: "over",
      wait: {
        session: "a1b2c3d4-2222-4c3b-9d4e-5a6b7c8d9e0f",
        creature: null,
        server: null,
        reason: "limited",
        since: "2026-11-05T09:03:00.000Z",
      },
    },
  ],
  "notifications.notice": [
    {
      notice: {
        id: "ask:c7",
        tier: "interrupt",
        held: true,
        creature: "pip",
        session: "f2c1a7d0-1111-4c3b-9d4e-5a6b7c8d9e0f",
        title: "Pip asks to run bun test",
        at: "2026-11-05T23:10:00.000Z",
        about: { kind: "ask", callId: "c7", tool: "bash" },
      },
    },
    {
      notice: {
        id: "chore:wren/triage/grants",
        tier: "digest",
        held: false,
        creature: "wren",
        session: null,
        title: 'Wren\'s chore "Morning triage" asks to write files',
        at: "2026-11-05T09:00:00.000Z",
        about: { kind: "chore", routineId: "triage", need: "grants", runId: null },
      },
    },
    {
      notice: {
        id: "run:wren:triage:1762329600000:1",
        tier: "log",
        held: false,
        creature: "wren",
        session: "a1b2c3d4-2222-4c3b-9d4e-5a6b7c8d9e0f",
        title: 'Wren finished the chore "Morning triage"',
        at: "2026-11-05T09:04:00.000Z",
        about: { kind: "run", routineId: "triage", runId: "wren:triage:1762329600000:1" },
      },
    },
    {
      notice: {
        id: "inbox",
        tier: "interrupt",
        held: false,
        creature: null,
        session: null,
        title: "3 things in memory wait for your review",
        at: "2026-11-05T10:00:00.000Z",
        about: { kind: "inbox", pending: 3 },
      },
    },
    {
      notice: {
        id: "question:wren/model-3c1f0a9b2d7e",
        tier: "interrupt",
        held: false,
        creature: "wren",
        session: null,
        title: '"Morning look" did not run: Wren\'s model is not answering.',
        at: "2026-11-05T09:13:00.000Z",
        about: { kind: "question", questionId: "model-3c1f0a9b2d7e", promise: "models-reachable" },
      },
    },
  ],
  "notifications.quiet": [
    {
      change: "began",
      quiet: {
        reason: "quiet-hours",
        since: "2026-11-05T22:00:00.000Z",
        until: "2026-11-06T07:00:00.000Z",
      },
    },
    {
      change: "changed",
      quiet: { reason: "do-not-disturb", since: "2026-11-05T23:00:00.000Z", until: null },
    },
    { change: "ended", quiet: null },
  ],
  "notifications.digest": [
    {
      change: "ready",
      digest: {
        id: "5e2a9c1b7d3f4a60",
        at: "2026-11-06T07:00:00.000Z",
        reason: "quiet-ended",
        notices: [
          {
            id: "ask:c7",
            tier: "interrupt",
            held: false,
            creature: "pip",
            session: "f2c1a7d0-1111-4c3b-9d4e-5a6b7c8d9e0f",
            title: "Pip asks to run bun test",
            at: "2026-11-05T23:10:00.000Z",
            about: { kind: "ask", callId: "c7", tool: "bash" },
          },
        ],
        folded: 0,
        seenAt: null,
      },
    },
    {
      change: "seen",
      digest: {
        id: "7c41d0e9a2b85f13",
        at: "2026-11-06T09:00:00.000Z",
        reason: "arrived",
        notices: [],
        folded: 0,
        seenAt: "2026-11-06T09:12:00.000Z",
      },
    },
  ],
  "notifications.settings": [
    {
      settings: {
        quietHours: { on: true, start: "22:00", end: "07:00" },
        doNotDisturb: false,
        tz: null,
      },
    },
    {
      settings: {
        quietHours: { on: false, start: "23:00", end: "06:30" },
        doNotDisturb: true,
        tz: "America/Chicago",
      },
    },
  ],
  "routine.fired": [
    {
      runId: "wren:triage:1762329600000:1",
      creature: "wren",
      routineId: "triage",
      attempt: 1,
      trigger: "cron",
      catchUp: false,
      firedAt: "2026-11-05T08:00:00.000Z",
      scheduledFor: "2026-11-05T08:00:07.000Z",
      startedAt: "2026-11-05T08:00:07.200Z",
      sessionId: "s3",
    },
  ],
  "routine.finished": [
    {
      run: {
        runId: "wren:triage:1762329600000:1",
        creature: "wren",
        routineId: "triage",
        attempt: 1,
        trigger: "cron",
        catchUp: false,
        firedAt: "2026-11-05T08:00:00.000Z",
        scheduledFor: "2026-11-05T08:00:07.000Z",
        status: "ended",
        sessionId: "s3",
        startedAt: "2026-11-05T08:00:07.200Z",
        endedAt: "2026-11-05T08:01:12.000Z",
        process: "completed",
        delivery: "delivered",
        verified: null,
        reason: null,
        usage: { inputTokens: 1200, outputTokens: 300 },
        cost: { usd: 0.004 },
        output: "routines/outputs/wren/triage/2026-11-05T08-00-00.000Z.md",
        notify: { tier: "digest", at: "2026-11-05T08:01:12.000Z" },
      },
      disabled: null,
    },
  ],
  "routine.needs": [
    {
      creature: "wren",
      routineId: "triage",
      items: [
        {
          creature: "wren",
          routineId: "triage",
          kind: "grants",
          tier: "interrupt",
          reason: "asks to write files",
          runId: "wren:triage:1762333320000:1",
          since: "2026-11-05T09:02:00.000Z",
          action: { verb: "accept", digest: "3f9c1a2b" },
        },
      ],
    },
    {
      creature: "wren",
      routineId: "look",
      items: [
        {
          creature: "wren",
          routineId: "look",
          kind: "disabled",
          tier: "interrupt",
          reason:
            "disabled after 5 failed runs in a row; the last: the run could not start: mill does not answer at http://127.0.0.1:11434; is its model server running?",
          runId: null,
          since: "2026-11-05T09:13:00.000Z",
          action: { verb: "answer" },
        },
      ],
    },
  ],
  "routine.checked": [
    {
      creature: "wren",
      routineId: "look",
      check: {
        at: "2026-11-05T09:00:01.200Z",
        command: "test -f build/failed",
        verdict: "quiet",
        exitCode: 0,
        ms: 1180,
        found: "exited 0: nothing to do, so nothing ran",
        output: "",
      },
    },
    {
      creature: "wren",
      routineId: "look",
      check: {
        at: "2026-11-05T09:15:00.900Z",
        command: "test -f build/failed",
        verdict: "woke",
        exitCode: 1,
        ms: 880,
        found: "exited 1: something to do, so the chore ran",
        output: "(exit code 1)",
      },
    },
  ],
  "workshop.changed": [
    {
      change: "started",
      workshop: {
        id: "pip-0a1b2c",
        creature: "pip",
        substrate: "sbx",
        state: "running",
        workdir: "/home/agent/workspace",
        brokers: ["anthropic"],
        limitations: ["cpus 2 and memory 4g are recorded, not applied"],
        display: true,
        createdAt: "2026-11-05T09:00:00.000Z",
      },
    },
  ],
  "models.changed": [{ node: "spark-ad4d", reason: "probe" }],
  "mesh.listener": [
    { change: "bound", address: "100.101.102.103", port: 47800 },
    { change: "unbound", address: "100.101.102.103", reason: "address-gone" },
    { change: "bind-failed", address: "100.101.102.103", error: "EADDRINUSE" },
    { change: "idle", reason: "not-running" },
    { change: "status-failed", error: "tailscaled is not reachable" },
    { change: "serve-warning", message: "Tailscale 1.104.1 serves; 1.104.4 fixed Serve" },
  ],
  "mesh.pairing": [
    { change: "started", pairing: pendingPairing },
    { change: "refused", peerStableId: "nStrangerE9f0CNTRL", reason: "not-the-owner" },
    { change: "aborted", pairingId: "p1", reason: "sas-mismatch" },
  ],
  "mesh.pair": [
    { change: "added", pair },
    { change: "removed", pairId: "pair-1", peerStableId: "nHostC3d4CNTRL", by: "keeper" },
  ],
  "mesh.grant": [
    { change: "issued", grant },
    { change: "refused", issuer: "nStrangerE9f0CNTRL", reason: "unknown-issuer" },
    { change: "revoked", grantId: "g1", by: "keeper" },
  ],
  "mesh.revocation": [
    {
      change: "undelivered",
      revocation: {
        kind: "grant",
        id: "g1",
        issuer: "nHouseA1b2CNTRL",
        target: "nHostC3d4CNTRL",
        revokedAt: "2026-11-05T10:00:00.000Z",
        nonce: "n1",
        signature: "c2ln",
      },
      attempts: 3,
      error: "fetch failed",
    },
  ],
  "mesh.peers": [
    {
      change: "lanes",
      peers: [
        { stableId: "nSparkStable1", path: { kind: "direct", endpoint: "192.168.4.58:41641" } },
      ],
    },
  ],
  "mesh.walked": [
    {
      origin: { kind: "mesh", creature: "pip", node: "nHouseA1b2CNTRL" },
      grantId: "g1",
      call,
      rules: [{ action: "bash", resource: "echo *", effect: "allow" }],
    },
  ],
  "show.proposed": [
    {
      setting: {
        id: "0b6f3c1e-8f2a-4c55-9d1e-3a7b2c4d5e6f",
        creature: "wren",
        sessionId: "s3",
        what: { kind: "report", ref: "r-triage-2026-11-08", title: "Morning triage" },
        rung: "card",
        why: "Two builds went red overnight; the report says which.",
        at: "2026-11-08T09:00:00.000Z",
        until: "rests",
        state: "live",
        from: null,
        origin: "creature",
        replaces: null,
        place: { kind: "workshop", creature: "wren" },
      },
    },
    {
      setting: {
        id: "5d2a9e47-1c3b-4f86-a0d2-7e9b8c6f4a13",
        creature: null,
        sessionId: "s1",
        what: { kind: "diff", ref: "cs-41" },
        rung: "unfold",
        why: "The change you asked for is ready to read.",
        at: "2026-11-08T09:05:00.000Z",
        until: "2026-11-08T10:00:00.000Z",
        state: "live",
        from: "s1",
        origin: "creature",
        replaces: "3e8b1d6a-7c42-4f19-8a5e-0d6c2b9f1e37",
        place: { kind: "porch" },
        size: "readable",
      },
    },
    {
      setting: {
        id: "9c4e7b21-3f5a-4d08-b6e1-2a8d0f9c7e54",
        creature: "wren",
        sessionId: "s3",
        what: { kind: "file", ref: "packages/build/src/red.ts" },
        rung: "unfold",
        why: "",
        at: "2026-11-08T09:02:00.000Z",
        until: "seen",
        state: "live",
        from: "0b6f3c1e-8f2a-4c55-9d1e-3a7b2c4d5e6f",
        origin: "keeper",
        replaces: null,
        place: { kind: "workshop", creature: "wren" },
      },
    },
    {
      setting: {
        id: "7a1c5e93-2b4d-4f60-8e7a-9c3b1d5f2a68",
        creature: "wren",
        sessionId: "s3",
        what: { kind: "file", ref: "docs/plan.md", title: "The plan" },
        rung: "card",
        why: "",
        at: "2026-11-20T09:00:00.000Z",
        until: "seen",
        state: "live",
        from: "0b6f3c1e-8f2a-4c55-9d1e-3a7b2c4d5e6f",
        origin: "creature",
        replaces: null,
        place: { kind: "project", creature: "wren", directory: "C:/work/anchor" },
        size: "card",
        where: "outside",
        seat: { x: 0, y: 0, w: 8, h: 12 },
        weight: "lead",
        mood: "calm",
      },
    },
  ],
  "show.changed": [
    {
      setting: {
        id: "7a1c5e93-2b4d-4f60-8e7a-9c3b1d5f2a68",
        creature: "wren",
        sessionId: "s3",
        what: { kind: "note", ref: "Ship the smaller fix first.", title: "Plan B" },
        rung: "card",
        why: "",
        at: "2026-11-21T09:00:00.000Z",
        until: "seen",
        state: "live",
        from: null,
        origin: "creature",
        replaces: null,
        place: { kind: "porch" },
        where: "outside",
        agent: { name: "claude-code", color: "magenta" },
        mark: "chosen",
        markTone: "good",
        signal: "needs-you",
      },
    },
  ],
  "show.settled": [
    { id: "0b6f3c1e-8f2a-4c55-9d1e-3a7b2c4d5e6f", outcome: "seen", by: "keeper" },
    {
      id: "7a1c5e93-2b4d-4f60-8e7a-9c3b1d5f2a68",
      outcome: "withdrawn",
      by: "creature",
      mood: "calm",
    },
  ],
  "show.arranged": [
    {
      arrangement: {
        id: "c2d4f6a8-1b3d-4e5f-9a7c-6e8d0b2f4a16",
        creature: "wren",
        sessionId: "s3",
        at: "2026-11-20T09:01:00.000Z",
        panes: ["7a1c5e93-2b4d-4f60-8e7a-9c3b1d5f2a68", "0b6f3c1e-8f2a-4c55-9d1e-3a7b2c4d5e6f"],
      },
    },
    {
      arrangement: {
        id: "d3e5a7b9-2c4e-4f6a-8b9d-7f9e1c3a5b27",
        creature: null,
        sessionId: "s1",
        at: "2026-11-20T09:02:00.000Z",
        panes: ["7a1c5e93-2b4d-4f60-8e7a-9c3b1d5f2a68", "0b6f3c1e-8f2a-4c55-9d1e-3a7b2c4d5e6f"],
        shape: "lead-and-stack",
        lead: "7a1c5e93-2b4d-4f60-8e7a-9c3b1d5f2a68",
        over: "display",
        mood: "eager",
      },
    },
    {
      arrangement: {
        id: "e4f6b8c0-3d5f-4a7b-9c0e-8a0f2d4b6c38",
        creature: "wren",
        sessionId: "s3",
        at: "2026-11-20T09:03:00.000Z",
        panes: ["7a1c5e93-2b4d-4f60-8e7a-9c3b1d5f2a68", "0b6f3c1e-8f2a-4c55-9d1e-3a7b2c4d5e6f"],
        relation: "alternatives",
      },
    },
    {
      arrangement: {
        id: "f5a7c9d1-4e6a-4b8c-8d1f-9b1a3e5c7d49",
        creature: "wren",
        sessionId: "s3",
        at: "2026-11-20T09:04:00.000Z",
        panes: ["7a1c5e93-2b4d-4f60-8e7a-9c3b1d5f2a68", "0b6f3c1e-8f2a-4c55-9d1e-3a7b2c4d5e6f"],
        seats: [
          { id: "7a1c5e93-2b4d-4f60-8e7a-9c3b1d5f2a68", seat: { x: 0, y: 0, w: 8, h: 12 } },
          { id: "0b6f3c1e-8f2a-4c55-9d1e-3a7b2c4d5e6f", seat: { x: 8, y: 0, w: 4, h: 6 } },
        ],
      },
    },
  ],
  "workspace.changed": [{ paths: ["notes/todo.md", "src/math.ts"], truncated: false }],
};

function envelopeShape(): Shape {
  const envelope = onTheWire("turn.started", samples["turn.started"][0]);
  return { ...(shapeOf(envelope) as { [key: string]: Shape }), payload: "object", type: "string" };
}

function wirePayloadsOf(type: WireEventType): unknown[] {
  return samples[type].map((payload) => onTheWire(type, payload).payload);
}

function onTheWire(type: WireEventType, payload: unknown): Record<string, unknown> {
  return JSON.parse(
    serializeEnvelope({ id: 1, ts: "2026-10-12T00:00:00.000Z", sessionId: "s1", type, payload }),
  );
}

function distinctShapes(values: readonly unknown[]): Shape[] {
  const shapes = new Map<string, Shape>();
  for (const value of values) {
    const shape = shapeOf(value);
    shapes.set(JSON.stringify(shape), shape);
  }
  return [...shapes.values()];
}

function single(shapes: Shape[]): Shape {
  return shapes.length === 1 && shapes[0] !== undefined ? shapes[0] : shapes;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (import.meta.main) writeContractFixtures();
