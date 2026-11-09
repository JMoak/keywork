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
  "turn.completed": [{ message, usage }],
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
        notify: { tier: "digest", at: "2026-11-05T18:00:00.000Z" },
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
          reason: "accept the write grant set 3f9c1a2b",
          runId: "wren:triage:1762333320000:1",
          since: "2026-11-05T09:02:00.000Z",
          action: { verb: "accept", digest: "3f9c1a2b" },
        },
      ],
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
      },
    },
  ],
  "show.settled": [{ id: "0b6f3c1e-8f2a-4c55-9d1e-3a7b2c4d5e6f", outcome: "seen", by: "keeper" }],
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
