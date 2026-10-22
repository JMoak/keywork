import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Message, ToolCallPart } from "@keywork/engine";
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
