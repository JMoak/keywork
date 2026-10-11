import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArcRegistry,
  type EngineEvents,
  EventBus,
  IneligibleDeliveryError,
  MemoryInertError,
  MemorySearch,
  MemoryStore,
  type Message,
  MissingSuccessorError,
  MockProvider,
  type Provider,
  type ProviderRequest,
  type SpillReference,
  type StagedItem,
  type Tool,
  type TurnDelta,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { type ChangeSource, changedFileSideCap } from "./changes.ts";
import {
  type BusEnvelope,
  type EngineEventType,
  EventLog,
  engineEventTypes,
  processLevelSessionId,
  serverEventTypes,
} from "./events.ts";
import {
  type AirlockDigest,
  type MemoryAirlock,
  maxFileSliceBytes,
  type SessionEntries,
} from "./host.ts";
import { listen } from "./listen.ts";
import type { MemoryWorkspace } from "./memory.ts";
import { routes } from "./openapi.ts";
import { createKeyworkServer, type KeyworkServer } from "./server.ts";
import {
  arcsUnavailable,
  inferenceOver,
  type MemorySurfaceOptions,
  memorySessionHost,
  type SseReader,
  sseReader,
} from "./testing.ts";

const token = "test-token-1234567890";
const origin = "http://keywork.test";

interface Harness {
  server: KeyworkServer;
  log: EventLog;
  call(path: string, init?: RequestInit): Promise<Response>;
  stream(lastEventId?: number): Promise<SseReader>;
}

function harness(
  options: {
    provider?: Provider;
    tools?: readonly Tool[];
    capacity?: number;
    asks?: "queue" | "headless";
    askTimeoutMs?: number;
    workspace?: { anchor: string; identity: string };
    changes?: ChangeSource | "untrusted";
    surfaces?: Omit<MemorySurfaceOptions, "log">;
    memory?: MemoryWorkspace;
    models?: Record<string, Provider>;
    trusted?: boolean;
  } = {},
) {
  const log = new EventLog({
    ...(options.capacity !== undefined && { capacity: options.capacity }),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
  });
  const memory = options.memory;
  const host = memorySessionHost({
    log,
    provider: options.provider ?? new MockProvider([]),
    ...(options.tools !== undefined && { tools: options.tools }),
    ...(options.asks !== undefined && { asks: options.asks }),
    ...(options.askTimeoutMs !== undefined && { askTimeoutMs: options.askTimeoutMs }),
    ...(options.changes !== undefined && { changes: options.changes }),
    ...(options.surfaces !== undefined && { surfaces: options.surfaces }),
    ...(memory !== undefined && { memory: async () => memory }),
    ...(options.models !== undefined && { inference: inferenceOver(options.models) }),
    ...(options.trusted !== undefined && { trusted: options.trusted }),
  });
  const server = createKeyworkServer({
    token,
    host,
    log,
    version: "0.0.1-test",
    ...(options.workspace !== undefined && { workspace: options.workspace }),
  });
  const call = (path: string, init: RequestInit = {}) =>
    server.fetch(
      new Request(`${origin}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      }),
    );
  const stream = async (lastEventId?: number) =>
    sseReader(
      await call("/events", {
        headers: lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) },
      }),
    );
  const built: Harness = { server, log, call, stream };
  return built;
}

async function createSession(h: Harness): Promise<string> {
  const response = await h.call("/sessions", { method: "POST" });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function collect(reader: SseReader, until: (event: string) => boolean) {
  const frames = [];
  for (;;) {
    const frame = await reader.next();
    frames.push(frame);
    if (until(frame.event ?? "")) return frames;
  }
}

const assistantMessage: Message = { role: "assistant", parts: [{ type: "text", text: "hi" }] };

const samplePayloads: { [K in EngineEventType]: EngineEvents[K] } = {
  "turn.started": { userText: "hello", entryId: "e1" },
  "turn.delta": { delta: { type: "text", text: "h" } },
  "turn.completed": { message: assistantMessage, usage: { inputTokens: 3, outputTokens: 1 } },
  "turn.interrupted": { message: assistantMessage },
  "queue.changed": { queued: [{ id: "q1", text: "later", behavior: "queue" }] },
  "tool.started": { call: { type: "tool-call", callId: "c1", name: "echo", arguments: { a: 1 } } },
  "tool.output": { chunk: "line\n", callId: "c1" },
  "tool.finished": { callId: "c1", output: "line\n", isError: false },
  "gate.ask": {
    ask: {
      tool: "bash",
      callId: "c2",
      arguments: { command: "rm x" },
      rule: "default",
      rules: [{ action: "bash", resource: "rm *", effect: "allow" }],
    },
  },
  "gate.permission": {
    decision: { tool: "bash", callId: "c2", verdict: "denied", gate: "headless" },
  },
  "gate.preset": { from: "standard", to: "open" },
  "session.mode": { mode: "plan" },
  "context.injected": { injection: { source: "memory-recall", id: "n1", scope: "workspace" } },
  "diagnostics.published": { path: "src/a.ts", count: 2 },
  "shell.reset": { replay: true },
  "extension.notice": { extension: "counter", level: "info", message: "counted 3" },
  "session.tree": { sessionId: "s1", leafId: "e2", reason: "fork", entryId: "e1", forkedTo: "s2" },
  "changes.updated": { sessionId: "s1", paths: ["src/a.ts"] },
  "engine.error": { error: new Error("boom") },
};

describe("GET /doc", () => {
  it("serves a structurally sane OpenAPI 3.1 document listing every route, without a token", async () => {
    const h = harness();
    const response = await h.server.fetch(new Request(`${origin}/doc`));
    expect(response.status).toBe(200);
    const doc = (await response.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<
        string,
        Record<string, { operationId: string; responses: object; security?: [] }>
      >;
      components: { securitySchemes: Record<string, { type: string; scheme: string }> };
      security: unknown[];
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("keywork");
    expect(doc.info.version).toBe("0.0.1-test");
    expect(doc.components.securitySchemes.bearer).toEqual({ type: "http", scheme: "bearer" });
    expect(doc.security).toEqual([{ bearer: [] }]);
    for (const route of routes) {
      const operation = doc.paths[route.path]?.[route.method.toLowerCase()];
      expect(operation?.operationId, `${route.method} ${route.path}`).toBe(route.operationId);
      expect(Object.keys(operation?.responses ?? {}).length).toBeGreaterThan(0);
    }
    expect(doc.paths["/doc"]?.get?.security).toEqual([]);
    expect(Object.keys(doc.paths)).toHaveLength(new Set(routes.map((route) => route.path)).size);
  });
});

describe("authentication", () => {
  const protectedCalls: Array<[method: string, path: string]> = [
    ["GET", "/events"],
    ["GET", "/sessions"],
    ["POST", "/sessions"],
    ["GET", "/sessions/s1"],
    ["POST", "/sessions/s1/prompt"],
    ["POST", "/sessions/s1/inject"],
    ["POST", "/sessions/s1/abort"],
    ["GET", "/sessions/s1/entries"],
    ["GET", "/sessions/s1/spills/x"],
    ["POST", "/sessions/s1/fork"],
    ["POST", "/sessions/s1/label"],
    ["POST", "/sessions/s1/leaf"],
    ["GET", "/sessions/s1/changes"],
    ["GET", "/sessions/s1/changes/file"],
    ["GET", "/workspace"],
    ["GET", "/tree"],
    ["GET", "/files"],
    ["POST", "/workspace/trust"],
    ["GET", "/themes"],
    ["GET", "/mcp"],
    ["GET", "/arcs"],
    ["POST", "/arcs"],
    ["GET", "/bots"],
    ["GET", "/workspaces"],
    ["POST", "/workspaces/use"],
    ["GET", "/memory"],
    ["POST", "/memory/inbox/x/approve"],
    ["POST", "/memory/ask"],
    ["POST", "/arcs/a/airlock/finish"],
  ];

  it.each(protectedCalls)(
    "%s %s answers 401 with an empty body when no token is sent",
    async (method, path) => {
      const h = harness();
      const response = await h.server.fetch(new Request(`${origin}${path}`, { method }));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    },
  );

  it("rejects a wrong token, a token of another length, and a non-bearer scheme alike", async () => {
    const h = harness();
    for (const authorization of [`Bearer ${token}x`, "Bearer nope", `Basic ${token}`, token]) {
      const response = await h.server.fetch(
        new Request(`${origin}/sessions`, { headers: { authorization } }),
      );
      expect(response.status, authorization).toBe(401);
    }
  });

  it("answers unknown routes and CORS preflight with 404 and no CORS headers", async () => {
    const h = harness();
    const preflight = await h.call("/sessions", { method: "OPTIONS" });
    expect(preflight.status).toBe(404);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect((await h.call("/nowhere")).status).toBe(404);
  });
});

describe("GET /events, the D7 test", () => {
  it("round-trips every engine event type as its JSON envelope with no translation", async () => {
    const h = harness();
    const bus = new EventBus<EngineEvents>();
    h.log.attach(bus, "s1");
    const recorded: BusEnvelope[] = [];
    h.log.subscribe((envelope) => recorded.push(envelope));
    for (const type of engineEventTypes) bus.emit(type, samplePayloads[type]);
    expect(recorded.map((envelope) => envelope.type)).toEqual([...engineEventTypes]);

    const reader = await h.stream(0);
    for (const [index, type] of engineEventTypes.entries()) {
      const envelope = recorded[index];
      const frame = await reader.next();
      expect(frame.id).toBe(String(envelope?.id));
      expect(frame.event).toBe(type);
      if (type === "engine.error") {
        expect(JSON.parse(frame.data)).toEqual({
          ...envelope,
          payload: { error: { name: "Error", message: "boom" } },
        });
      } else {
        expect(frame.data).toBe(JSON.stringify(envelope));
        expect(JSON.parse(frame.data).payload).toEqual(samplePayloads[type]);
      }
    }
    await reader.close();
  });

  it("delivers live events in bus order and resumes from Last-Event-ID", async () => {
    const h = harness();
    const bus = new EventBus<EngineEvents>();
    h.log.attach(bus, "s1");
    for (const mode of ["a", "b", "c", "d", "e"]) bus.emit("session.mode", { mode });

    const resumed = await h.stream(3);
    expect((await resumed.next()).id).toBe("4");
    expect((await resumed.next()).id).toBe("5");
    bus.emit("session.mode", { mode: "f" });
    const live = await resumed.next();
    expect(live.id).toBe("6");
    expect(JSON.parse(live.data).payload).toEqual({ mode: "f" });
    await resumed.close();

    const fresh = await h.stream();
    bus.emit("session.mode", { mode: "g" });
    expect((await fresh.next()).id).toBe("7");
    await fresh.close();
  });

  it("says so in a comment when the resume point fell off the ring", async () => {
    const h = harness({ capacity: 2 });
    const bus = new EventBus<EngineEvents>();
    h.log.attach(bus, "s1");
    for (const mode of ["a", "b", "c", "d", "e"]) bus.emit("session.mode", { mode });
    const reader = await h.stream(1);
    expect((await reader.next()).id).toBe("4");
    expect((await reader.next()).id).toBe("5");
    expect(reader.raw()).toContain(": resumed with a gap, events 2 to 3 are gone");
    await reader.close();
  });

  it("ignores a malformed Last-Event-ID and starts live", async () => {
    const h = harness();
    const bus = new EventBus<EngineEvents>();
    h.log.attach(bus, "s1");
    bus.emit("session.mode", { mode: "old" });
    const reader = sseReader(await h.call("/events", { headers: { "last-event-id": "abc" } }));
    bus.emit("session.mode", { mode: "new" });
    expect(JSON.parse((await reader.next()).data).payload).toEqual({ mode: "new" });
    await reader.close();
  });
});

describe("sessions", () => {
  const echo: Tool = {
    name: "echo",
    description: "echoes",
    parameters: { type: "object" },
    execute: async (args) => JSON.stringify(args),
  };

  it("lists, creates and reads sessions", async () => {
    const h = harness();
    expect(await (await h.call("/sessions")).json()).toEqual({ sessions: [] });
    const id = await createSession(h);
    const listed = (await (await h.call("/sessions")).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(listed.sessions.map((session) => session.id)).toEqual([id]);
    const read = await h.call(`/sessions/${id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id, live: true, messages: [] });
    expect((await h.call("/sessions/nope")).status).toBe(404);
  });

  it("runs a mock-provider turn on prompt and streams turn.* and tool.* events", async () => {
    const provider = new MockProvider([
      toolCallTurn({ type: "tool-call", callId: "c1", name: "echo", arguments: { n: 1 } }),
      textTurn("done"),
    ]);
    const h = harness({ provider, tools: [echo] });
    const id = await createSession(h);
    const reader = await h.stream();
    const accepted = await h.call(`/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "echo one" }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      sessionId: id,
      accepted: true,
      queued: false,
      behavior: "queue",
    });

    const frames = await collect(reader, (event) => event === "turn.completed");
    const types = frames.map((frame) => frame.event);
    expect(types[0]).toBe("turn.started");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.finished");
    expect(types.indexOf("tool.started")).toBeLessThan(types.indexOf("tool.finished"));
    for (const frame of frames) expect(JSON.parse(frame.data).sessionId).toBe(id);
    await reader.close();

    const read = (await (await h.call(`/sessions/${id}`)).json()) as { messages: Message[] };
    expect(read.messages.at(-1)?.parts).toEqual([{ type: "text", text: "done" }]);
  });

  it("refuses a prompt without text and a prompt for an unknown session", async () => {
    const h = harness();
    const id = await createSession(h);
    const post = (path: string, body: string) =>
      h.call(path, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await post(`/sessions/${id}/prompt`, "{}")).status).toBe(400);
    expect((await post(`/sessions/${id}/prompt`, "not json")).status).toBe(400);
    expect((await post(`/sessions/${id}/prompt`, JSON.stringify({ text: "  " }))).status).toBe(400);
    expect((await post("/sessions/nope/prompt", JSON.stringify({ text: "hi" }))).status).toBe(404);
  });

  it("aborts a running turn and reports idle when nothing runs", async () => {
    const h = harness({ provider: hangingProvider() });
    const id = await createSession(h);
    expect(await (await h.call(`/sessions/${id}/abort`, { method: "POST" })).json()).toEqual({
      sessionId: id,
      interrupted: false,
    });
    const reader = await h.stream();
    await h.call(`/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "wait forever" }),
    });
    expect((await reader.next()).event).toBe("turn.started");
    const abort = await h.call(`/sessions/${id}/abort`, { method: "POST" });
    expect(await abort.json()).toEqual({ sessionId: id, interrupted: true });
    const frames = await collect(reader, (event) => event === "turn.interrupted");
    expect(frames.at(-1)?.event).toBe("turn.interrupted");
    await reader.close();
    expect((await h.call("/sessions/nope/abort", { method: "POST" })).status).toBe(404);
  });
});

describe("shutdown", () => {
  it("closes every open event stream", async () => {
    const h = harness();
    const first = await h.call("/events");
    const second = await h.call("/events");
    await h.server.close();
    for (const response of [first, second]) {
      const reader = response.body?.getReader();
      let finished = false;
      while (!finished) finished = (await reader?.read())?.done ?? true;
      expect(finished).toBe(true);
    }
  });

  it("binds 127.0.0.1 on an ephemeral port, answers over a real socket, and stops cleanly", async () => {
    const log = new EventLog();
    const host = memorySessionHost({ log, provider: new MockProvider([]) });
    const server = await listen({ token, host, log, version: "0.0.1-test", port: 0 });
    try {
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
      expect(server.port).toBeGreaterThan(0);
      expect((await fetch(`${server.url}/doc`)).status).toBe(200);
      expect((await fetch(`${server.url}/sessions`)).status).toBe(401);
      const listed = await fetch(`${server.url}/sessions`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await listed.json()).toEqual({ sessions: [] });
    } finally {
      await server.close();
    }
    await expect(fetch(`${server.url}/doc`)).rejects.toThrow();
  });
});

function hangingProvider(): Provider {
  return {
    name: "hanging",
    async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
      yield { type: "text", text: "..." };
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      request.signal?.throwIfAborted();
    },
  };
}

describe("asks", () => {
  const scribble: Tool = {
    name: "scribble",
    description: "writes",
    parameters: { type: "object" },
    mutates: true,
    execute: async () => "written",
  };
  const askingTurns = () =>
    new MockProvider([
      toolCallTurn({ type: "tool-call", callId: "c1", name: "scribble", arguments: { path: "a" } }),
      textTurn("done"),
    ]);
  const post = (h: Harness, path: string, body: string) =>
    h.call(path, { method: "POST", headers: { "content-type": "application/json" }, body });

  it("announces the ask, lists it, and resumes the turn with the client's verdict as gate user", async () => {
    const h = harness({ provider: askingTurns(), tools: [scribble], asks: "queue" });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, JSON.stringify({ text: "write it" }));
    const asked = await collect(reader, (event) => event === "gate.ask");
    expect(JSON.parse(asked.at(-1)?.data ?? "{}").payload.ask).toEqual({
      tool: "scribble",
      callId: "c1",
      arguments: { path: "a" },
      rule: "default",
      rules: [],
    });
    const listed = (await (await h.call("/asks")).json()) as { asks: unknown[] };
    expect(listed.asks).toEqual([
      expect.objectContaining({
        sessionId: id,
        callId: "c1",
        tool: "scribble",
        arguments: { path: "a" },
      }),
    ]);
    expect((await post(h, "/asks/c1", "{}")).status).toBe(400);
    expect((await post(h, "/asks/nope", JSON.stringify({ verdict: "granted" }))).status).toBe(404);
    const answered = await post(h, "/asks/c1", JSON.stringify({ verdict: "granted" }));
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ callId: "c1", settled: true });
    const decided = await collect(reader, (event) => event === "gate.permission");
    expect(JSON.parse(decided.at(-1)?.data ?? "{}").payload.decision).toEqual({
      tool: "scribble",
      callId: "c1",
      verdict: "granted",
      gate: "user",
      scope: "once",
    });
    await collect(reader, (event) => event === "turn.completed");
    expect((await post(h, "/asks/c1", JSON.stringify({ verdict: "denied" }))).status).toBe(409);
    expect(await (await h.call("/asks")).json()).toEqual({ asks: [] });
    await reader.close();
    const read = (await (await h.call(`/sessions/${id}`)).json()) as { messages: Message[] };
    expect(read.messages[2]?.parts[0]).toMatchObject({ output: "written", isError: false });
  });

  it("times out an unanswered ask as a headless denial", async () => {
    const h = harness({
      provider: askingTurns(),
      tools: [scribble],
      asks: "queue",
      askTimeoutMs: 20,
    });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, JSON.stringify({ text: "write it" }));
    const decided = await collect(reader, (event) => event === "gate.permission");
    expect(JSON.parse(decided.at(-1)?.data ?? "{}").payload.decision).toMatchObject({
      verdict: "denied",
      gate: "headless",
    });
    await reader.close();
  });
});

describe("ask scopes and grants", () => {
  const shell: Tool = {
    name: "bash",
    description: "runs a command",
    parameters: { type: "object" },
    mutates: true,
    execute: async (args) => `ran ${(args as { command: string }).command}`,
  };
  const write: Tool = { ...shell, name: "write", execute: async () => "written" };
  const bashCall = (callId: string, command: string) =>
    toolCallTurn({ type: "tool-call", callId, name: "bash", arguments: { command } });
  const post = (h: Harness, path: string, body: unknown) =>
    h.call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const pushRule = { action: "bash", resource: "git push *", effect: "allow" };
  const decisions = (frames: readonly { event: string | undefined; data: string }[]) =>
    frames
      .filter((frame) => frame.event === "gate.permission")
      .map((frame) => JSON.parse(frame.data).payload.decision);
  const askRules = (frames: readonly { data: string }[]) =>
    JSON.parse(frames.at(-1)?.data ?? "{}").payload.ask.rules;

  it("lets a trusted workspace run read-only commands under the bundle, reported as gate trusted", async () => {
    const h = harness({
      provider: new MockProvider([bashCall("c1", "git status --short"), textTurn("done")]),
      tools: [shell],
      asks: "queue",
      trusted: true,
    });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "look" });
    const frames = await collect(reader, (event) => event === "turn.completed");
    expect(frames.some((frame) => frame.event === "gate.ask")).toBe(false);
    expect(decisions(frames)).toEqual([
      { tool: "bash", callId: "c1", verdict: "granted", gate: "trusted" },
    ]);
    const permissions = (await (await h.call("/permissions")).json()) as {
      trusted: boolean;
      bundle: unknown[];
    };
    expect(permissions.trusted).toBe(true);
    expect(permissions.bundle).toContainEqual({
      action: "bash",
      resource: "git status*",
      effect: "allow",
    });
    await reader.close();
  });

  it("answers an untrusted workspace with an empty bundle and asks for a read-only command", async () => {
    const h = harness({
      provider: new MockProvider([bashCall("c1", "git status"), textTurn("done")]),
      tools: [shell],
      asks: "queue",
    });
    expect(await (await h.call("/permissions")).json()).toEqual({
      trusted: false,
      bundle: [],
      workspace: [],
      session: {},
    });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "look" });
    const asked = await collect(reader, (event) => event === "gate.ask");
    expect(askRules(asked)).toEqual([
      { action: "bash", resource: "git status *", effect: "allow" },
    ]);
    await post(h, "/asks/c1", { verdict: "denied", scope: "workspace" });
    await collect(reader, (event) => event === "turn.completed");
    const after = (await (await h.call("/permissions")).json()) as { workspace: unknown[] };
    expect(after.workspace).toEqual([]);
    await reader.close();
  });

  it("stops asking for the rest of the session after a session-scoped grant", async () => {
    const h = harness({
      provider: new MockProvider([
        bashCall("c1", "git push origin main"),
        bashCall("c2", "git push origin dev"),
        textTurn("done"),
      ]),
      tools: [shell],
      asks: "queue",
    });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "push both" });
    const asked = await collect(reader, (event) => event === "gate.ask");
    expect(askRules(asked)).toEqual([pushRule]);
    const answered = await post(h, "/asks/c1", { verdict: "granted", scope: "session" });
    expect(answered.status).toBe(200);
    const frames = await collect(reader, (event) => event === "turn.completed");
    expect(frames.some((frame) => frame.event === "gate.ask")).toBe(false);
    expect(decisions(frames)).toEqual([
      { tool: "bash", callId: "c1", verdict: "granted", gate: "user", scope: "session" },
      { tool: "bash", callId: "c2", verdict: "granted", gate: "user", scope: "session" },
    ]);
    expect(await (await h.call("/permissions")).json()).toMatchObject({
      workspace: [],
      session: { [id]: [pushRule] },
    });
    await reader.close();
  });

  it("records a workspace grant, lists it, and revokes it", async () => {
    const h = harness({
      provider: new MockProvider([bashCall("c1", "git push origin main"), textTurn("done")]),
      tools: [shell],
      asks: "queue",
    });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "push" });
    await collect(reader, (event) => event === "gate.ask");
    await post(h, "/asks/c1", { verdict: "granted", scope: "workspace" });
    const frames = await collect(reader, (event) => event === "turn.completed");
    expect(decisions(frames)).toEqual([
      { tool: "bash", callId: "c1", verdict: "granted", gate: "user", scope: "workspace" },
    ]);
    expect(await (await h.call("/permissions")).json()).toMatchObject({
      workspace: [pushRule],
      session: {},
    });
    const revoke = (body: unknown) => post(h, "/permissions/workspace/revoke", body);
    expect((await revoke({})).status).toBe(400);
    expect((await revoke({ rule: { ...pushRule, effect: "deny" } })).status).toBe(400);
    const revoked = await revoke({ rule: pushRule });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: pushRule });
    expect((await revoke({ rule: pushRule })).status).toBe(404);
    const after = (await (await h.call("/permissions")).json()) as { workspace: unknown[] };
    expect(after.workspace).toEqual([]);
    await reader.close();
  });

  it("refuses to grant write beyond once and keeps the ask open for a once answer", async () => {
    const h = harness({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "write", arguments: { path: "a" } }),
        textTurn("done"),
      ]),
      tools: [write],
      asks: "queue",
    });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "write" });
    await collect(reader, (event) => event === "gate.ask");
    const refused = await post(h, "/asks/c1", { verdict: "granted", scope: "session" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "write and edit are approved once at a time" });
    const unknownScope = await post(h, "/asks/c1", { verdict: "granted", scope: "sometimes" });
    expect(unknownScope.status).toBe(400);
    expect((await post(h, "/asks/c1", { verdict: "granted" })).status).toBe(200);
    await collect(reader, (event) => event === "turn.completed");
    await reader.close();
  });
});

describe("the document and session detail", () => {
  it("names the workspace it serves and parameterizes every path segment", async () => {
    const workspace = { anchor: "/work", identity: "abc123def456" };
    const h = harness({ workspace });
    const doc = (await (await h.server.fetch(new Request(`${origin}/doc`))).json()) as {
      info: { workspace?: unknown };
      paths: Record<string, Record<string, { parameters?: Array<{ name: string }> }>>;
    };
    expect(doc.info.workspace).toEqual(workspace);
    expect(doc.paths["/asks/{callId}"]?.post?.parameters).toEqual([
      { name: "callId", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("reports asOf as the latest event id the messages reflect", async () => {
    const h = harness({ provider: new MockProvider([textTurn("hi")]) });
    const id = await createSession(h);
    const reader = await h.stream();
    await h.call(`/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    const frames = await collect(reader, (event) => event === "turn.completed");
    await reader.close();
    const detail = (await (await h.call(`/sessions/${id}`)).json()) as { asOf: number };
    expect(detail.asOf).toBe(Number(frames.at(-1)?.id));
  });
});

describe("external prompt injection", () => {
  const voice = { kind: "external", client: "wispr-flow" };
  const inject = (h: Harness, id: string, body: unknown) =>
    h.call(`/sessions/${id}/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("starts a turn on an idle session and runs it exactly like a typed prompt", async () => {
    const typed = harness({ provider: new MockProvider([textTurn("lights on")]) });
    const typedId = await createSession(typed);
    const typedReader = await typed.stream();
    await typed.call(`/sessions/${typedId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "turn on the lights" }),
    });
    await collect(typedReader, (event) => event === "turn.completed");
    await typedReader.close();

    const h = harness({ provider: new MockProvider([textTurn("lights on")]) });
    const id = await createSession(h);
    const reader = await h.stream();
    const accepted = await inject(h, id, { text: "turn on the lights", client: "wispr-flow" });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ sessionId: id, accepted: true, queued: false });

    const frames = await collect(reader, (event) => event === "turn.completed");
    await reader.close();
    expect(frames[0]?.event).toBe("turn.started");
    expect(JSON.parse(frames[0]?.data ?? "{}").payload).toEqual({
      userText: "turn on the lights",
      origin: voice,
    });
    const messagesOf = async (server: Harness, session: string) =>
      ((await (await server.call(`/sessions/${session}`)).json()) as { messages: Message[] })
        .messages;
    expect(await messagesOf(h, id)).toEqual(await messagesOf(typed, typedId));
  });

  it("queues behind a running turn and starts once that turn ends", async () => {
    const h = harness({ provider: hangingProvider() });
    const id = await createSession(h);
    const reader = await h.stream();
    await h.call(`/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "typed first" }),
    });
    expect((await reader.next()).event).toBe("turn.started");

    const queued = await inject(h, id, { text: "spoken second", client: "wispr-flow" });
    expect(await queued.json()).toEqual({ sessionId: id, accepted: true, queued: true });
    const announced = await collect(reader, (event) => event === "queue.changed");
    expect(JSON.parse(announced.at(-1)?.data ?? "{}").payload.queued).toEqual([
      expect.objectContaining({ text: "spoken second", behavior: "queue", origin: voice }),
    ]);

    await h.call(`/sessions/${id}/abort`, { method: "POST" });
    const next = await collect(reader, (event) => event === "turn.started");
    const types = next.map((frame) => frame.event);
    expect(types).toContain("turn.interrupted");
    expect(types.indexOf("turn.interrupted")).toBeLessThan(types.lastIndexOf("turn.started"));
    expect(JSON.parse(next.at(-1)?.data ?? "{}").payload).toEqual({
      userText: "spoken second",
      origin: voice,
    });
    await h.call(`/sessions/${id}/abort`, { method: "POST" });
    await reader.close();
  });

  it("refuses a client without the ticket's token and runs nothing", async () => {
    const h = harness({ provider: new MockProvider([textTurn("never")]) });
    const id = await createSession(h);
    const before = h.log.latestId();
    for (const authorization of ["Bearer stolen-or-stale", ""]) {
      const response = await h.server.fetch(
        new Request(`${origin}/sessions/${id}/inject`, {
          method: "POST",
          headers: authorization === "" ? {} : { authorization },
          body: JSON.stringify({ text: "rm -rf everything", client: "intruder" }),
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect(h.log.latestId()).toBe(before);
    const read = (await (await h.call(`/sessions/${id}`)).json()) as { messages: Message[] };
    expect(read.messages).toEqual([]);
  });

  it("refuses a body without text or a usable client name, and an unknown session", async () => {
    const h = harness();
    const id = await createSession(h);
    for (const body of [
      {},
      { text: "hi" },
      { text: "  ", client: "wispr-flow" },
      { text: "hi", client: "" },
      { text: "hi", client: "two words" },
      { text: "hi", client: "x".repeat(65) },
      { text: "hi", client: 7 },
    ]) {
      expect((await inject(h, id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await inject(h, "nope", { text: "hi", client: "wispr-flow" })).status).toBe(404);
  });
});

describe("the session tree", () => {
  const post = (h: Harness, path: string, body: unknown) =>
    h.call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const entriesOf = async (h: Harness, id: string) =>
    (await (await h.call(`/sessions/${id}/entries`)).json()) as SessionEntries;
  const payloadOf = (frame: { data: string } | undefined) =>
    JSON.parse(frame?.data ?? "{}").payload;

  async function sessionAfterOneTurn(h: Harness) {
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "first question" });
    await collect(reader, (event) => event === "session.tree");
    return { id, reader };
  }

  it("lists the flat entries with parent ids, the leaf, labels and the active path", async () => {
    const h = harness({ provider: new MockProvider([textTurn("first answer")]) });
    const { id, reader } = await sessionAfterOneTurn(h);
    const tree = await entriesOf(h, id);
    expect(tree.sessionId).toBe(id);
    expect(tree.entries.map((entry) => entry.type)).toEqual(["message", "message"]);
    const [question, answer] = tree.entries;
    expect(question?.parentId).toBeNull();
    expect(answer?.parentId).toBe(question?.id);
    expect(tree.leafId).toBe(answer?.id);
    expect(tree.activePath).toEqual([question?.id, answer?.id]);
    expect(tree.labels).toEqual({});
    expect(question).toMatchObject({
      message: { role: "user", parts: [{ type: "text", text: "first question" }] },
    });
    await reader.close();
    expect((await h.call("/sessions/nope/entries")).status).toBe(404);
  });

  it("labels an entry, clears it with null, and announces each on session.tree", async () => {
    const h = harness({ provider: new MockProvider([textTurn("answer")]) });
    const { id, reader } = await sessionAfterOneTurn(h);
    const [question] = (await entriesOf(h, id)).entries;
    const entryId = question?.id ?? "";
    const labelled = await post(h, `/sessions/${id}/label`, { entryId, label: "start" });
    expect(labelled.status).toBe(200);
    expect(await labelled.json()).toEqual({ entryId, label: "start" });
    expect((await entriesOf(h, id)).labels).toEqual({ [entryId]: "start" });
    const announced = await collect(reader, (event) => event === "session.tree");
    expect(payloadOf(announced.at(-1))).toMatchObject({ sessionId: id, reason: "label", entryId });
    const cleared = await post(h, `/sessions/${id}/label`, { entryId, label: null });
    expect(await cleared.json()).toEqual({ entryId, label: null });
    expect((await entriesOf(h, id)).labels).toEqual({});
    await reader.close();

    for (const body of [{}, { entryId }, { entryId, label: "" }, { entryId: "", label: "x" }]) {
      expect((await post(h, `/sessions/${id}/label`, body)).status, JSON.stringify(body)).toBe(400);
    }
    const ghost = await post(h, `/sessions/${id}/label`, { entryId: "ghost", label: "x" });
    expect(ghost.status).toBe(404);
    expect((await post(h, "/sessions/nope/label", { entryId, label: "x" })).status).toBe(404);
  });

  it("forks at an entry into a new session that lists, reads, and starts at that entry", async () => {
    const h = harness({ provider: new MockProvider([textTurn("answer")]) });
    const { id, reader } = await sessionAfterOneTurn(h);
    const [question] = (await entriesOf(h, id)).entries;
    const forked = await post(h, `/sessions/${id}/fork`, { entryId: question?.id });
    expect(forked.status).toBe(201);
    const summary = (await forked.json()) as { id: string };
    expect(summary.id).not.toBe(id);
    const listed = (await (await h.call("/sessions")).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(listed.sessions.map((session) => session.id)).toContain(summary.id);
    const read = (await (await h.call(`/sessions/${summary.id}`)).json()) as {
      messages: Message[];
    };
    expect(read.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "first question" }] },
    ]);
    const forkTree = await entriesOf(h, summary.id);
    expect(forkTree.entries.map((entry) => entry.id)).toEqual([question?.id]);
    expect(forkTree.leafId).toBe(question?.id);
    const announced = await collect(reader, (event) => event === "session.tree");
    expect(payloadOf(announced.at(-1))).toEqual({
      sessionId: id,
      leafId: (await entriesOf(h, id)).leafId,
      reason: "fork",
      entryId: question?.id,
      forkedTo: summary.id,
    });
    await reader.close();
    expect((await post(h, `/sessions/${id}/fork`, {})).status).toBe(400);
    expect((await post(h, `/sessions/${id}/fork`, { entryId: "ghost" })).status).toBe(404);
    expect((await post(h, "/sessions/nope/fork", { entryId: question?.id })).status).toBe(404);
  });

  it("moves the leaf back, rebuilds the conversation over the shorter path, and branches from there", async () => {
    const h = harness({
      provider: new MockProvider([textTurn("answer"), textTurn("second answer")]),
    });
    const { id, reader } = await sessionAfterOneTurn(h);
    const [question, answer] = (await entriesOf(h, id)).entries;
    const moved = await post(h, `/sessions/${id}/leaf`, { entryId: question?.id });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ leafId: question?.id });
    const announced = await collect(reader, (event) => event === "session.tree");
    expect(payloadOf(announced.at(-1))).toEqual({
      sessionId: id,
      leafId: question?.id,
      reason: "leaf",
      entryId: question?.id,
    });
    const state = await collect(reader, (event) => event === "session.state");
    expect(payloadOf(state.at(-1))).toMatchObject({ leafId: question?.id, undoable: true });
    const read = (await (await h.call(`/sessions/${id}`)).json()) as { messages: Message[] };
    expect(read.messages.map((message) => message.role)).toEqual(["user"]);

    await post(h, `/sessions/${id}/prompt`, { text: "second question" });
    await collect(reader, (event) => event === "session.tree");
    const tree = await entriesOf(h, id);
    expect(tree.entries).toHaveLength(4);
    const [, , secondQuestion, secondAnswer] = tree.entries;
    expect(secondQuestion?.parentId).toBe(question?.id);
    expect(answer?.parentId).toBe(question?.id);
    expect(tree.activePath).toEqual([question?.id, secondQuestion?.id, secondAnswer?.id]);
    expect(tree.leafId).toBe(secondAnswer?.id);

    const rooted = await post(h, `/sessions/${id}/leaf`, { entryId: null });
    expect(await rooted.json()).toEqual({ leafId: null });
    expect((await entriesOf(h, id)).activePath).toEqual([]);
    await reader.close();

    expect((await post(h, `/sessions/${id}/leaf`, {})).status).toBe(400);
    expect((await post(h, `/sessions/${id}/leaf`, { entryId: "ghost" })).status).toBe(404);
    expect((await post(h, "/sessions/nope/leaf", { entryId: null })).status).toBe(404);
  });

  it("refuses to move the leaf while a turn is running", async () => {
    const h = harness({ provider: hangingProvider() });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "wait" });
    expect((await reader.next()).event).toBe("turn.started");
    const refused = await post(h, `/sessions/${id}/leaf`, { entryId: null });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "a turn is running" });
    await h.call(`/sessions/${id}/abort`, { method: "POST" });
    await reader.close();
  });
});

describe("changes", () => {
  const fakeChanges = (
    befores: Record<string, string>,
    working: Record<string, string>,
    turnsByPath: Record<string, number> = {},
  ): ChangeSource => ({
    checkpoints: {
      baseline: async () => "base-tree",
      changedSince: async () =>
        Object.keys(working)
          .filter((path) => working[path] !== befores[path])
          .map((path) => {
            const turn = turnsByPath[path];
            return { path, added: 1, deleted: 0, ...(turn !== undefined && { turn }) };
          }),
      contentAt: async (_tree, path) => befores[path],
    },
    readWorkingFile: async (path) => working[path],
  });
  const fileOf = async (h: Harness, id: string, path: string) =>
    h.call(`/sessions/${id}/changes/file?${new URLSearchParams({ path })}`);

  it("lists changed files with provenance and reads both sides of one", async () => {
    const h = harness({
      changes: fakeChanges(
        { "src/a.ts": "old\n" },
        { "src/a.ts": "new\n", "notes.md": "n\n" },
        { "src/a.ts": 1, "notes.md": 2 },
      ),
    });
    const id = await createSession(h);
    const listed = await h.call(`/sessions/${id}/changes`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      trusted: true,
      baseline: "session start",
      files: [
        { path: "src/a.ts", added: 1, deleted: 0, turn: 1 },
        { path: "notes.md", added: 1, deleted: 0, turn: 2 },
      ],
    });
    expect(await (await fileOf(h, id, "src/a.ts")).json()).toEqual({
      trusted: true,
      path: "src/a.ts",
      before: "old\n",
      after: "new\n",
      truncated: false,
    });
    expect(await (await fileOf(h, id, "notes.md")).json()).toMatchObject({
      before: null,
      after: "n\n",
      note: "new",
    });
    expect((await h.call("/sessions/nope/changes")).status).toBe(404);
    expect((await fileOf(h, "nope", "src/a.ts")).status).toBe(404);
  });

  it("notes deleted, unreadable and binary files, and caps each side at 1 MiB", async () => {
    const exact = "x".repeat(changedFileSideCap);
    const over = `${exact}y`;
    const h = harness({
      changes: fakeChanges(
        { gone: "was\n", "bin.dat": "a\0b", exact, over },
        { "bin.dat": "a\0c", exact, over: `${over}z` },
      ),
    });
    const id = await createSession(h);
    expect(await (await fileOf(h, id, "gone")).json()).toMatchObject({
      before: "was\n",
      after: null,
      note: "deleted",
    });
    expect(await (await fileOf(h, id, "never")).json()).toMatchObject({
      before: null,
      after: null,
      note: "unreadable",
    });
    expect(await (await fileOf(h, id, "bin.dat")).json()).toEqual({
      trusted: true,
      path: "bin.dat",
      before: null,
      after: null,
      note: "binary",
      truncated: false,
    });
    const atCap = (await (await fileOf(h, id, "exact")).json()) as {
      truncated: boolean;
      before: string;
    };
    expect(atCap.truncated).toBe(false);
    expect(atCap.before).toHaveLength(changedFileSideCap);
    const pastCap = (await (await fileOf(h, id, "over")).json()) as {
      truncated: boolean;
      before: string;
      after: string;
    };
    expect(pastCap.truncated).toBe(true);
    expect(pastCap.before).toHaveLength(changedFileSideCap);
    expect(pastCap.after).toHaveLength(changedFileSideCap);
  });

  it("refuses a missing, absolute or escaping path", async () => {
    const h = harness({ changes: fakeChanges({}, {}) });
    const id = await createSession(h);
    expect((await h.call(`/sessions/${id}/changes/file`)).status).toBe(400);
    const escaping = ["", "../secret", "a/../../b", "/etc/passwd", "C:\\work\\x", "a//b", "./a"];
    for (const path of escaping) expect((await fileOf(h, id, path)).status, path).toBe(400);
  });

  it("answers trusted: false with nothing for an untrusted workspace, and 409 with no baseline", async () => {
    const untrusted = harness({ changes: "untrusted" });
    const id = await createSession(untrusted);
    expect(await (await untrusted.call(`/sessions/${id}/changes`)).json()).toEqual({
      trusted: false,
      files: [],
    });
    expect(await (await fileOf(untrusted, id, "a")).json()).toEqual({
      trusted: false,
      path: "a",
      before: null,
      after: null,
      truncated: false,
    });
    const bare = harness();
    const bareId = await createSession(bare);
    const refused = await bare.call(`/sessions/${bareId}/changes`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "no baseline" });
    expect((await fileOf(bare, bareId, "a")).status).toBe(409);
  });

  it("announces changes.updated with the changed paths after a write tool finishes", async () => {
    const working: Record<string, string> = {};
    const write: Tool = {
      name: "write",
      description: "writes",
      parameters: { type: "object" },
      execute: async (args) => {
        const { path, content } = args as { path: string; content: string };
        working[path] = content;
        return "written";
      },
    };
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "c1",
        name: "write",
        arguments: { path: "notes.txt", content: "hello\n" },
      }),
      textTurn("done"),
    ]);
    const h = harness({ provider, tools: [write], changes: fakeChanges({}, working) });
    const id = await createSession(h);
    const reader = await h.stream();
    await h.call(`/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "write" }),
    });
    const frames = await collect(reader, (event) => event === "changes.updated");
    const types = frames.map((frame) => frame.event);
    expect(types.indexOf("tool.finished")).toBeLessThan(types.indexOf("changes.updated"));
    expect(JSON.parse(frames.at(-1)?.data ?? "{}")).toMatchObject({
      sessionId: id,
      payload: { sessionId: id, paths: ["notes.txt"] },
    });
    await reader.close();
  });
});

describe("the workspace family", () => {
  const files = {
    "src/a.ts": "alpha\n",
    "src/deep/b.ts": "beta",
    "dist/out.js": "built",
    ".env": "SECRET=1",
    "bin.dat": "a\u0000b",
    "README.md": "hello world",
    big: "x".repeat(maxFileSliceBytes + 10),
  };
  const surfaced = (surfaces: Omit<MemorySurfaceOptions, "log"> = {}) =>
    harness({ surfaces: { files, ignored: ["dist"], ...surfaces } });
  const bodyOf = async (response: Response) => (await response.json()) as Record<string, unknown>;

  it("describes the workspace with its trust decision and readiness", async () => {
    const h = surfaced();
    const response = await h.call("/workspace");
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      anchor: { root: "/memory", source: "launch" },
      identity: "memory",
      declared: false,
      trust: "undecided",
      readiness: "undecided",
    });
    const ready = surfaced({ trust: "trusted", declared: true });
    expect(await bodyOf(await ready.call("/workspace"))).toMatchObject({ readiness: "ready" });
    const refused = surfaced({ trust: "untrusted" });
    expect(await bodyOf(await refused.call("/workspace"))).toMatchObject({ readiness: "refused" });
  });

  it("lists one level, directories first, flagging ignored and hidden entries instead of dropping them", async () => {
    const h = surfaced();
    const root = await bodyOf(await h.call("/tree"));
    expect(root).toEqual({
      path: "",
      entries: [
        { name: "dist", kind: "dir", ignored: true, hidden: false },
        { name: "src", kind: "dir", ignored: false, hidden: false },
        { name: ".env", kind: "file", ignored: false, hidden: true },
        { name: "big", kind: "file", ignored: false, hidden: false },
        { name: "bin.dat", kind: "file", ignored: false, hidden: false },
        { name: "README.md", kind: "file", ignored: false, hidden: false },
      ],
    });
    expect(await bodyOf(await h.call("/tree?path=src"))).toEqual({
      path: "src",
      entries: [
        { name: "deep", kind: "dir", ignored: false, hidden: false },
        { name: "a.ts", kind: "file", ignored: false, hidden: false },
      ],
    });
    expect((await h.call("/tree?path=nope")).status).toBe(404);
  });

  it("jails /tree and /files to the workspace scope, without needing trust", async () => {
    const h = surfaced({ trust: "untrusted" });
    for (const path of ["..", "../outside", "src/../..", "/etc", "C:/Windows"]) {
      const tree = await h.call(`/tree?path=${encodeURIComponent(path)}`);
      expect(tree.status, path).toBe(403);
      expect(await bodyOf(tree)).toEqual({
        error: `${path} escapes the project root; tools may only touch files inside it`,
      });
      expect((await h.call(`/files?path=${encodeURIComponent(path)}`)).status, path).toBe(403);
    }
    expect((await h.call("/tree?path=src")).status).toBe(200);
    expect((await h.call("/files?path=src/a.ts")).status).toBe(200);
  });

  it("reads byte ranges, caps a request at 1 MiB, flags eof, and refuses NUL content", async () => {
    const h = surfaced();
    expect(await bodyOf(await h.call("/files?path=README.md"))).toEqual({
      path: "README.md",
      bytes: 11,
      from: 0,
      to: 11,
      text: "hello world",
      truncated: false,
      eof: true,
      encoding: "utf-8",
    });
    expect(await bodyOf(await h.call("/files?path=README.md&from=0&to=5"))).toMatchObject({
      text: "hello",
      eof: false,
    });
    expect(await bodyOf(await h.call("/files?path=README.md&from=6&to=99"))).toMatchObject({
      from: 6,
      to: 11,
      text: "world",
      eof: true,
      truncated: false,
    });
    const capped = await bodyOf(await h.call("/files?path=big"));
    expect(capped).toMatchObject({
      from: 0,
      to: maxFileSliceBytes,
      truncated: true,
      eof: false,
      bytes: maxFileSliceBytes + 10,
    });
    expect((capped.text as string).length).toBe(maxFileSliceBytes);
    expect(await bodyOf(await h.call(`/files?path=big&from=${maxFileSliceBytes}`))).toMatchObject({
      from: maxFileSliceBytes,
      to: maxFileSliceBytes + 10,
      text: "xxxxxxxxxx",
      truncated: false,
      eof: true,
    });
    const binary = await h.call("/files?path=bin.dat");
    expect(binary.status).toBe(415);
    expect(await bodyOf(binary)).toEqual({ error: "binary file" });
    expect((await h.call("/files?path=nope")).status).toBe(404);
    expect((await h.call("/files?path=src")).status).toBe(404);
    expect((await h.call("/files")).status).toBe(400);
    expect((await h.call("/files?path=README.md&from=abc")).status).toBe(400);
    expect((await h.call("/files?path=README.md&to=-1")).status).toBe(400);
  });

  it("records trust once for the served root, answers reopens, and fires surface.changed", async () => {
    const h = surfaced();
    const reader = await h.stream();
    const granted = await h.call("/workspace/trust", { method: "POST", body: "{}" });
    expect(granted.status).toBe(200);
    expect(await bodyOf(granted)).toEqual({ trusted: true, root: "/memory", reopens: true });
    const frame = await reader.next();
    expect(frame.event).toBe("surface.changed");
    expect(JSON.parse(frame.data)).toMatchObject({
      sessionId: processLevelSessionId,
      payload: { kind: "workspace" },
    });
    await reader.close();
    expect(await bodyOf(await h.call("/workspace"))).toMatchObject({ trust: "trusted" });

    const before = h.log.latestId();
    const again = await h.call("/workspace/trust", { method: "POST" });
    expect(await bodyOf(again)).toEqual({ trusted: true, root: "/memory", reopens: false });
    expect(h.log.latestId()).toBe(before);
  });

  it("never accepts a path in the body and refuses a root already marked untrusted", async () => {
    const h = surfaced();
    const pathed = await h.call("/workspace/trust", {
      method: "POST",
      body: JSON.stringify({ path: "/somewhere/else" }),
    });
    expect(pathed.status).toBe(400);
    expect(await bodyOf(await h.call("/workspace"))).toMatchObject({ trust: "undecided" });
    const refused = surfaced({ trust: "untrusted" });
    const response = await refused.call("/workspace/trust", { method: "POST", body: "{}" });
    expect(response.status).toBe(409);
    expect((await bodyOf(response)).error).toContain("keywork trust reverses that");
  });

  it("lists themes with the system placeholder", async () => {
    const h = surfaced();
    expect(await bodyOf(await h.call("/themes"))).toEqual({
      themes: [],
      active: "keywork-night",
      placeholders: ["system"],
    });
  });
});

describe("the status family", () => {
  const post = (h: Harness, path: string, body?: unknown) =>
    h.call(path, { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });
  const bodyOf = async (response: Response) => (await response.json()) as Record<string, unknown>;
  const ready = { trust: "trusted", declared: true } as const;

  it("lists MCP servers, toggles and restarts one, lists its tools, and fires surface.changed over SSE", async () => {
    const fixture = {
      name: "fixture",
      state: "connected",
      enabled: true,
      toolCount: 2,
      transport: "stdio",
    } as const;
    const h = harness({ surfaces: { mcp: [fixture], mcpTools: { fixture: ["echo", "time"] } } });
    expect(await bodyOf(await h.call("/mcp"))).toEqual({ servers: [fixture] });
    const reader = await h.stream();
    const disabled = await post(h, "/mcp/fixture/enabled", { enabled: false });
    expect(await bodyOf(disabled)).toMatchObject({ enabled: false, state: "down", toolCount: 0 });
    const frame = await reader.next();
    expect(frame.event).toBe("surface.changed");
    expect(JSON.parse(frame.data)).toMatchObject({
      sessionId: processLevelSessionId,
      payload: { kind: "mcp" },
    });
    await reader.close();
    expect(await bodyOf(await h.call("/mcp/fixture/tools"))).toEqual({ tools: [] });
    expect(await bodyOf(await post(h, "/mcp/fixture/restart"))).toMatchObject({
      enabled: true,
      state: "connected",
      toolCount: 2,
    });
    expect(await bodyOf(await h.call("/mcp/fixture/tools"))).toEqual({ tools: ["echo", "time"] });
    expect((await post(h, "/mcp/fixture/enabled", { enabled: "yes" })).status).toBe(400);
    expect((await post(h, "/mcp/nope/restart")).status).toBe(404);
    expect((await h.call("/mcp/nope/tools")).status).toBe(404);
  });

  it("walks arcs: new, bind, close through the airlock, abandon, with surface.changed on the bus", async () => {
    const h = harness({ surfaces: ready });
    expect(await bodyOf(await h.call("/arcs"))).toEqual({ arcs: [], ordinals: {} });
    const first = await post(h, "/arcs", {});
    expect(first.status).toBe(201);
    expect(await bodyOf(first)).toMatchObject({ slug: "arc-1", status: "active", sessions: 0 });
    expect(h.log.since(0).at(-1)).toMatchObject({
      sessionId: processLevelSessionId,
      type: "surface.changed",
      payload: { kind: "arcs" },
    });
    expect((await post(h, "/arcs", { slug: "dock-v2" })).status).toBe(201);
    expect((await post(h, "/arcs", { slug: "Bad Slug" })).status).toBe(400);
    expect((await post(h, "/arcs", { slug: "dock-v2" })).status).toBe(409);
    expect((await post(h, "/arcs", { slug: 7 })).status).toBe(400);
    expect(await bodyOf(await h.call("/arcs"))).toMatchObject({
      ordinals: { "arc-1": 0, "dock-v2": 1 },
    });

    const id = await createSession(h);
    expect((await post(h, `/sessions/${id}/arc`, {})).status).toBe(400);
    expect((await post(h, "/sessions/nope/arc", { slug: "dock-v2" })).status).toBe(404);
    expect((await post(h, `/sessions/${id}/arc`, { slug: "nope" })).status).toBe(404);
    const bound = await post(h, `/sessions/${id}/arc`, { slug: "dock-v2" });
    expect(await bodyOf(bound)).toEqual({ sessionId: id, arc: "dock-v2" });
    expect(await bodyOf(await h.call(`/sessions/${id}`))).toMatchObject({ arc: "dock-v2" });
    const listed = (await bodyOf(await h.call("/arcs"))) as {
      arcs: Array<{ slug: string; sessions: number }>;
    };
    expect(listed.arcs.find((arc) => arc.slug === "dock-v2")?.sessions).toBe(1);

    const closed = await post(h, "/arcs/dock-v2/close", { direction: "ship it" });
    expect(await bodyOf(closed)).toEqual({ kind: "closed", delivered: 0, released: 1 });
    expect((await bodyOf(await h.call(`/sessions/${id}`))).arc).toBeUndefined();
    expect((await post(h, "/arcs/dock-v2/close")).status).toBe(409);
    expect((await post(h, "/arcs/nope/close")).status).toBe(404);
    expect((await post(h, `/sessions/${id}/arc`, { slug: "dock-v2" })).status).toBe(409);
    expect(await bodyOf(await post(h, "/arcs/arc-1/abandon"))).toEqual({
      slug: "arc-1",
      abandoned: true,
    });
    expect((await post(h, "/arcs/arc-1/abandon")).status).toBe(409);
    expect(await bodyOf(await post(h, `/sessions/${id}/arc`, { slug: null }))).toEqual({
      sessionId: id,
      arc: null,
    });
  });

  it("answers 403 with keywork's own message for arcs when the workspace is not ready", async () => {
    const notReady = [{}, { trust: "untrusted" }, { trust: "trusted", declared: false }] as const;
    for (const surfaces of notReady) {
      const h = harness({ surfaces });
      const id = await createSession(h);
      for (const response of [
        await h.call("/arcs"),
        await post(h, "/arcs", { slug: "dock-v2" }),
        await post(h, "/arcs/dock-v2/close"),
        await post(h, "/arcs/dock-v2/abandon"),
        await post(h, `/sessions/${id}/arc`, { slug: "dock-v2" }),
      ]) {
        expect(response.status).toBe(403);
        expect(await bodyOf(response)).toEqual({ error: arcsUnavailable });
      }
    }
  });

  it("lists bots, switches a session's bot between turns only, and defines a new bot", async () => {
    const scribe = { name: "scribe", sigil: "S", source: "user" } as const;
    const h = harness({ provider: hangingProvider(), surfaces: { ...ready, bots: [scribe] } });
    expect(await bodyOf(await h.call("/bots"))).toEqual({ bots: [{ ...scribe, sessions: 0 }] });
    const id = await createSession(h);
    expect((await post(h, `/sessions/${id}/bot`, { slug: "nope" })).status).toBe(404);
    expect((await post(h, `/sessions/${id}/bot`, {})).status).toBe(400);
    expect((await post(h, "/sessions/nope/bot", { slug: "scribe" })).status).toBe(404);
    expect(await bodyOf(await post(h, `/sessions/${id}/bot`, { slug: "scribe" }))).toEqual({
      sessionId: id,
      bot: "scribe",
    });
    expect(await bodyOf(await h.call(`/sessions/${id}`))).toMatchObject({ bot: "scribe" });
    expect(await bodyOf(await h.call("/bots"))).toEqual({ bots: [{ ...scribe, sessions: 1 }] });
    expect(h.log.since(0).at(-1)).toMatchObject({
      type: "surface.changed",
      payload: { kind: "bots" },
    });

    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "wait" });
    expect((await reader.next()).event).toBe("turn.started");
    const busy = await post(h, `/sessions/${id}/bot`, { slug: null });
    expect(busy.status).toBe(409);
    expect(await bodyOf(busy)).toEqual({ error: "a turn is running" });
    await post(h, `/sessions/${id}/abort`);
    await collect(reader, (event) => event === "turn.interrupted");
    await reader.close();
    expect(await bodyOf(await post(h, `/sessions/${id}/bot`, { slug: null }))).toEqual({
      sessionId: id,
      bot: null,
    });

    const created = await post(h, "/bots", { slug: "helper", scope: "project", purpose: "helps" });
    expect(created.status).toBe(201);
    expect(await bodyOf(created)).toEqual({
      name: "helper",
      sigil: "H",
      source: "project",
      learning: "notes",
      description: "helps",
    });
    expect((await post(h, "/bots", { slug: "helper", scope: "user" })).status).toBe(409);
    expect((await post(h, "/bots", { slug: "Nope!", scope: "user" })).status).toBe(400);
    expect((await post(h, "/bots", { slug: "x", scope: "team" })).status).toBe(400);
    const untrusted = harness({ surfaces: { bots: [scribe] } });
    const refused = await post(untrusted, "/bots", { slug: "helper", scope: "project" });
    expect(refused.status).toBe(403);
    expect((await bodyOf(refused)).error).toContain("project bots need a trusted workspace");
  });

  it("lists, creates, uses, focuses and unfocuses named workspaces", async () => {
    const root = {
      slug: undefined,
      name: "root",
      declared: true,
      current: true,
      notes: 0,
      focusDirs: [],
      sessions: 0,
      lastUsed: undefined,
    };
    const h = harness({ surfaces: { workspaces: [root] } });
    expect(await bodyOf(await h.call("/workspaces"))).toEqual({ workspaces: [root] });
    const created = await post(h, "/workspaces", { slug: "api-v2" });
    expect(created.status).toBe(201);
    expect(await bodyOf(created)).toEqual({ slug: "api-v2" });
    expect(h.log.since(0).at(-1)).toMatchObject({
      type: "surface.changed",
      payload: { kind: "workspaces" },
    });
    expect((await post(h, "/workspaces", { slug: "api-v2" })).status).toBe(409);
    expect((await post(h, "/workspaces", { slug: "Not A Slug" })).status).toBe(400);
    expect((await post(h, "/workspaces", {})).status).toBe(400);

    expect(await bodyOf(await post(h, "/workspaces/use", { slug: "api-v2" }))).toEqual({
      slug: "api-v2",
      reopens: true,
    });
    expect(await bodyOf(await post(h, "/workspaces/use", { slug: null }))).toEqual({
      slug: null,
      reopens: true,
    });
    expect((await post(h, "/workspaces/use", { slug: "nope" })).status).toBe(404);
    expect((await post(h, "/workspaces/use", {})).status).toBe(400);

    const focused = await post(h, "/workspaces/api-v2/focus", { dir: "packages/api" });
    expect(await bodyOf(focused)).toEqual({ dir: "packages/api" });
    expect((await post(h, "/workspaces/api-v2/focus", { dir: "packages/api" })).status).toBe(400);
    const listed = (await bodyOf(await h.call("/workspaces"))) as {
      workspaces: Array<{ slug?: string; focusDirs: string[] }>;
    };
    expect(listed.workspaces.find((choice) => choice.slug === "api-v2")?.focusDirs).toEqual([
      "packages/api",
    ]);
    const unfocused = await post(h, "/workspaces/api-v2/unfocus", { dir: "packages/api" });
    expect(await bodyOf(unfocused)).toEqual({ dir: "packages/api" });
    expect((await post(h, "/workspaces/api-v2/unfocus", { dir: "packages/api" })).status).toBe(400);
    expect((await post(h, "/workspaces/default/focus", { dir: "docs" })).status).toBe(200);
    expect((await post(h, "/workspaces/nope/focus", { dir: "docs" })).status).toBe(404);
    expect((await post(h, "/workspaces/api-v2/focus", {})).status).toBe(400);
  });
});

describe("memory", () => {
  const tempDir = scratchDirs("keywork-server-memory-");
  const now = () => new Date("2026-09-06T12:00:00.000Z");
  const inert = { error: new MemoryInertError().message };
  const post = (h: Harness, path: string, body?: unknown) =>
    h.call(path, {
      method: "POST",
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  const read = async <T>(h: Harness, path: string): Promise<T> => {
    const response = await h.call(path);
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  };

  function vaultIn(root: string, trusted = true) {
    const store = new MemoryStore({ vaultRoot: root, trusted, now });
    return { store, search: new MemorySearch(store) };
  }

  async function plantedVault(root: string) {
    const vault = vaultIn(root);
    await vault.store.writeNote({
      title: "Dock Ratio",
      body: "Docks split 50/50 by default.\n",
      provenance: "user",
      pinned: true,
    });
    await vault.store.writeNote({
      title: "Theme Drift",
      body: "Themes drift toward [[Dock Ratio]].\n",
      provenance: "agent",
    });
    await vault.store.writeMoc(["Dock Ratio", "Theme Drift"], "agent");
    await vault.store.appendDaily("learned how docks split", "agent");
    await vault.store.writeNote({
      title: "Stray Claim",
      body: "Thirds, maybe.\n",
      provenance: "untrusted",
    });
    return vault;
  }

  async function arcWithNote(root: string): Promise<ArcRegistry> {
    const arcs = new ArcRegistry({ vaultRoot: root, trusted: true, now });
    await arcs.createArc("dock-v2");
    await arcs.arcStore("dock-v2").writeNote({
      title: "Dock Finding",
      body: "Docks want thirds.\n",
      provenance: "agent",
      confidence: 0.6,
    });
    return arcs;
  }

  async function stagedIds(store: MemoryStore): Promise<string[]> {
    return (await store.listStaged()).map((item) => item.id);
  }

  async function nextInboxEvent(reader: SseReader): Promise<BusEnvelope> {
    for (;;) {
      const frame = await reader.next();
      if (frame.event === "memory.inbox") return JSON.parse(frame.data) as BusEnvelope;
    }
  }

  it("answers every read as trusted: false with empty lists and every write as 403 when the workspace is untrusted", async () => {
    const vault = vaultIn(await tempDir(), false);
    const h = harness({ memory: { vault } });
    expect(await read(h, "/memory")).toEqual({
      trusted: false,
      layers: [],
      inbox: [],
      ledger: [],
      audit: [],
      gardener: { state: "idle" },
      airlocks: [],
    });
    expect(await read(h, "/memory/inbox")).toEqual({ trusted: false, items: [], count: 0 });
    expect(await read(h, "/memory/notes")).toEqual({ trusted: false, notes: [] });
    expect(await read(h, "/memory/notes/Dock%20Ratio")).toEqual({ trusted: false, note: null });
    expect(await read(h, "/memory/daily")).toEqual({ trusted: false, dates: [] });
    expect(await read(h, "/memory/daily/2026-09-06")).toEqual({
      trusted: false,
      date: "2026-09-06",
      entries: [],
    });
    expect(await read(h, "/memory/ledger")).toEqual({ trusted: false, entries: [] });
    expect(await read(h, "/arcs/dock-v2/airlock")).toEqual({ trusted: false, digest: null });
    const asked = await post(h, "/memory/ask", { query: "docks" });
    expect(await asked.json()).toEqual({ trusted: false, hits: [], source: "lexical" });
    const writes: Array<[path: string, body: unknown]> = [
      ["/memory/inbox/x/approve", undefined],
      ["/memory/inbox/x/discard", undefined],
      ["/memory/ledger/x/revert", undefined],
      ["/arcs/dock-v2/airlock/candidates/Note", { choice: "deliver" }],
      ["/arcs/dock-v2/airlock/questions", { title: "Why", choice: "drop" }],
      ["/arcs/dock-v2/airlock/deliver", undefined],
      ["/arcs/dock-v2/airlock/finish", { force: true }],
    ];
    for (const [path, body] of writes) {
      const response = await post(h, path, body);
      expect(response.status, path).toBe(403);
      expect(await response.json()).toEqual(inert);
    }
    expect(h.log.latestId()).toBe(0);
  });

  it("reads the garden: layers with counts, curing and the prompt budget, the inbox as engine rows, the ledger, the audit and the gardener", async () => {
    const vault = await plantedVault(await tempDir());
    const h = harness({ memory: { vault } });
    const garden = await read<{
      trusted: boolean;
      layers: unknown[];
      inbox: StagedItem[];
      ledger: unknown[];
      audit: unknown[];
      gardener: unknown;
      airlocks: unknown[];
    }>(h, "/memory");
    expect(garden.trusted).toBe(true);
    expect(garden.layers).toEqual([
      {
        id: "workspace",
        kind: "workspace",
        label: "workspace",
        notes: 2,
        curing: { "0": 1, "1": 0, "2": 0, "3": 1 },
        prompt: { budget: 4096, used: expect.any(Number) },
      },
    ]);
    expect(garden.inbox).toEqual(await vault.store.listStaged());
    expect(garden.inbox[0]).toMatchObject({ kind: "note", target: "Stray Claim.md" });
    expect(garden.ledger).toEqual(JSON.parse(JSON.stringify(vault.store.ledger())));
    expect(garden.audit).toEqual([]);
    expect(garden.gardener).toEqual({ state: "idle" });
    expect(garden.airlocks).toEqual([]);
  });

  it("approves and discards staged items, moving them out of the inbox and firing memory.inbox with the new count", async () => {
    const vault = await plantedVault(await tempDir());
    await vault.store.appendDaily("a stray daily line", "untrusted");
    const h = harness({ memory: { vault } });
    const [daily, note] = await stagedIds(vault.store);
    const inbox = await read<{ count: number; items: StagedItem[] }>(h, "/memory/inbox");
    expect(inbox.count).toBe(2);
    expect(inbox.items.map((item) => item.kind)).toEqual(["daily", "note"]);

    const reader = await h.stream();
    const approved = await post(h, `/memory/inbox/${note}/approve`);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({
      id: note,
      result: { path: "Stray Claim.md", staged: false, ledgerId: expect.any(String) },
    });
    expect(await nextInboxEvent(reader)).toMatchObject({
      sessionId: "",
      type: "memory.inbox",
      payload: { count: 1, kinds: { daily: 1 } },
    });
    expect(await vault.store.readNote("Stray Claim")).toMatchObject({ provenance: "untrusted" });

    const discarded = await post(h, `/memory/inbox/${daily}/discard`);
    expect(await discarded.json()).toEqual({ id: daily, discarded: true });
    expect((await nextInboxEvent(reader)).payload).toEqual({ count: 0, kinds: {} });
    await reader.close();
    expect(await read(h, "/memory/inbox")).toEqual({ trusted: true, items: [], count: 0 });
    expect((await post(h, `/memory/inbox/${note}/approve`)).status).toBe(404);
    expect((await post(h, `/memory/inbox/${daily}/discard`)).status).toBe(404);
    const garden = await read<{ audit: Array<{ event: string }> }>(h, "/memory");
    expect(garden.audit.map((entry) => entry.event)).toEqual([
      "approved note → Stray Claim.md",
      "discarded daily → daily/2026-09-06.md",
    ]);
  });

  it("passes every staged kind through as the engine's own row, so a new kind needs no server change", async () => {
    const vault = await plantedVault(await tempDir());
    await vault.store.propose([
      {
        kind: "contradiction",
        a: "Dock Ratio",
        b: "Theme Drift",
        aProvenance: "user",
        bProvenance: "agent",
        confidence: 0.7,
      },
      {
        kind: "borderline-promotion",
        title: "Dock Rule",
        body: "Keep docks even.",
        confidence: 0.4,
        source: "daily/2026-09-06",
      },
    ]);
    const h = harness({ memory: { vault } });
    const inbox = await read<{ items: StagedItem[]; count: number }>(h, "/memory/inbox");
    expect(inbox.count).toBe(3);
    expect(inbox.items).toEqual(await vault.store.listStaged());
  });

  it("lists notes with their layer, curing, injection and relations, narrows by layer, and reads one by name", async () => {
    const root = await tempDir();
    const vault = await plantedVault(root);
    const arcs = await arcWithNote(root);
    const h = harness({ memory: { vault, arcs } });
    const listed = await read<{ notes: Array<Record<string, unknown>> }>(h, "/memory/notes");
    expect(listed.notes.map((note) => [note.name, note.layer, note.curing, note.injected])).toEqual(
      [
        ["Dock Ratio", "workspace", 3, true],
        ["Theme Drift", "workspace", 0, true],
        ["Dock Finding", "arc:dock-v2", 1, false],
      ],
    );
    expect(listed.notes[0]).toMatchObject({
      provenance: "user",
      pinned: true,
      recalls: 0,
      relations: expect.any(Array),
      frontmatter: expect.objectContaining({ provenance: "user" }),
    });
    const garden = await read<{ layers: Array<{ id: string; arc?: string; notes: number }> }>(
      h,
      "/memory",
    );
    expect(garden.layers.map((layer) => [layer.id, layer.arc, layer.notes])).toEqual([
      ["workspace", undefined, 2],
      ["arc:dock-v2", "dock-v2", 1],
    ]);
    const arcOnly = await read<{ notes: Array<{ name: string }> }>(
      h,
      "/memory/notes?layer=arc:dock-v2",
    );
    expect(arcOnly.notes.map((note) => note.name)).toEqual(["Dock Finding"]);
    expect((await h.call("/memory/notes?layer=arc:nope")).status).toBe(404);

    const one = await read<{ note: Record<string, unknown> }>(h, "/memory/notes/Dock%20Ratio");
    expect(one.note).toMatchObject({
      name: "Dock Ratio",
      body: "Docks split 50/50 by default.\n",
      curing: 3,
    });
    const inArc = await read<{ note: { name: string } }>(
      h,
      "/memory/notes/Dock%20Finding?layer=arc:dock-v2",
    );
    expect(inArc.note.name).toBe("Dock Finding");
    expect((await h.call("/memory/notes/Dock%20Finding")).status).toBe(404);
    expect((await h.call("/memory/notes/Nowhere")).status).toBe(404);
  });

  it("lists daily dates and reads a day, refusing a malformed date", async () => {
    const vault = await plantedVault(await tempDir());
    const h = harness({ memory: { vault } });
    expect(await read(h, "/memory/daily")).toEqual({ trusted: true, dates: ["2026-09-06"] });
    expect(await read(h, "/memory/daily/2026-09-06")).toEqual({
      trusted: true,
      date: "2026-09-06",
      entries: [{ time: "12:00", provenance: "agent", text: "learned how docks split" }],
    });
    expect(await read(h, "/memory/daily/2026-09-07")).toEqual({
      trusted: true,
      date: "2026-09-07",
      entries: [],
    });
    expect((await h.call("/memory/daily/yesterday")).status).toBe(400);
  });

  it("reverts a ledger entry, reports needs-rebase after an outside edit, and refuses an unknown id", async () => {
    const root = await tempDir();
    const vault = await plantedVault(root);
    const edited = await vault.store.writeNote({
      title: "Dock Ratio",
      body: "Docks split 60/40 after all.\n",
      provenance: "user",
    });
    const h = harness({ memory: { vault } });
    const ledger = await read<{ entries: Array<{ id: string; op: string }> }>(h, "/memory/ledger");
    expect(ledger.entries.at(-1)).toMatchObject({ id: edited.ledgerId, op: "edit" });

    const reverted = await post(h, `/memory/ledger/${edited.ledgerId}/revert`);
    expect(await reverted.json()).toEqual({ id: edited.ledgerId, outcome: "reverted" });
    expect((await vault.store.readNote("Dock Ratio"))?.body).toBe(
      "Docks split 50/50 by default.\n",
    );

    const again = await vault.store.writeNote({
      title: "Dock Ratio",
      body: "Docks split 70/30 now.\n",
      provenance: "user",
    });
    const file = join(root, "Dock Ratio.md");
    await writeFile(file, `${await readFile(file, "utf8")}edited outside keywork\n`);
    const stale = await post(h, `/memory/ledger/${again.ledgerId}/revert`);
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ id: again.ledgerId, outcome: "needs-rebase" });
    expect(await readFile(file, "utf8")).toContain("edited outside keywork");
    expect((await post(h, "/memory/ledger/nope/revert")).status).toBe(404);
  });

  it("answers a question with ranked hits, layered with an arc when asked, and refuses an empty or oversized query", async () => {
    const root = await tempDir();
    const vault = await plantedVault(root);
    const arcs = await arcWithNote(root);
    const h = harness({ memory: { vault, arcs } });
    const plain = await post(h, "/memory/ask", { query: "docks split" });
    expect(await plain.json()).toMatchObject({
      trusted: true,
      source: "lexical",
      hits: [
        expect.objectContaining({ note: "Dock Ratio", layer: "workspace", superseded: false }),
      ],
    });
    const layered = (await (
      await post(h, "/memory/ask", { query: "docks", arc: "dock-v2" })
    ).json()) as {
      hits: Array<{ note: string; layer: string; boost?: number }>;
    };
    expect(layered.hits.map((hit) => [hit.note, hit.layer, hit.boost])).toEqual(
      expect.arrayContaining([["Dock Finding", "arc:dock-v2", 2]]),
    );
    for (const body of [
      {},
      { query: "   " },
      { query: "x".repeat(2001) },
      { query: "ok", arc: "" },
    ]) {
      expect((await post(h, "/memory/ask", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("maps the airlock walk over HTTP: digest, triage, deliver and finish, with their refusals", async () => {
    const vault = await plantedVault(await tempDir());
    const digest: AirlockDigest = {
      arc: "dock-v2",
      candidates: [
        {
          note: "Dock Finding",
          title: "Dock Finding",
          provenance: "agent",
          eligible: true,
          shortfalls: [],
        },
        {
          note: "Uncited Hunch",
          title: "Uncited Hunch",
          provenance: "agent",
          eligible: false,
          shortfalls: ["uncited"],
        },
      ],
      questions: [{ title: "Tie order", provenance: "user" }],
    };
    const finishes: unknown[] = [];
    const airlock: MemoryAirlock = {
      digest: async (slug) => (slug === "dock-v2" ? digest : undefined),
      triageCandidate: async (slug, note, choice) => {
        if (note === "Uncited Hunch" && choice === "deliver")
          throw new IneligibleDeliveryError(slug, note, ["uncited"]);
        const candidate = digest.candidates.find((found) => found.note === note);
        if (candidate !== undefined) candidate.choice = choice;
      },
      triageQuestion: async (slug, title, choice) => {
        if (choice === "carry") throw new MissingSuccessorError(slug);
        const question = digest.questions.find((found) => found.title === title);
        if (question !== undefined) question.choice = choice;
      },
      deliverEligible: async () => 1,
      finish: async (slug, options) => {
        finishes.push([slug, options]);
        return { kind: "wedged", sessions: ["s1"] };
      },
    };
    const h = harness({ memory: { vault, airlock } });
    expect(await read(h, "/arcs/dock-v2/airlock")).toEqual({ trusted: true, digest });
    expect((await h.call("/arcs/next-arc/airlock")).status).toBe(404);

    const candidates = "/arcs/dock-v2/airlock/candidates";
    expect((await post(h, `${candidates}/Dock%20Finding`, {})).status).toBe(400);
    expect((await post(h, `${candidates}/Nowhere`, { choice: "deliver" })).status).toBe(404);
    expect((await post(h, "/arcs/next-arc/airlock/candidates/X", { choice: "leave" })).status).toBe(
      404,
    );
    expect((await post(h, `${candidates}/Uncited%20Hunch`, { choice: "deliver" })).status).toBe(
      409,
    );
    const reader = await h.stream();
    const decided = await post(h, `${candidates}/Dock%20Finding`, { choice: "deliver" });
    expect(decided.status).toBe(200);
    expect(((await decided.json()) as AirlockDigest).candidates[0]?.choice).toBe("deliver");
    expect((await nextInboxEvent(reader)).payload).toEqual({ count: 1, kinds: { note: 1 } });
    await reader.close();

    const questions = "/arcs/dock-v2/airlock/questions";
    expect((await post(h, questions, { title: "Tie order" })).status).toBe(400);
    expect((await post(h, questions, { title: "Nope", choice: "drop" })).status).toBe(404);
    expect((await post(h, questions, { title: "Tie order", choice: "carry" })).status).toBe(409);
    const resolved = await post(h, questions, { title: "Tie order", choice: "resolve" });
    expect(((await resolved.json()) as AirlockDigest).questions[0]?.choice).toBe("resolve");

    expect(await (await post(h, "/arcs/dock-v2/airlock/deliver")).json()).toEqual({ delivered: 1 });
    expect((await post(h, "/arcs/next-arc/airlock/deliver")).status).toBe(404);

    expect((await post(h, "/arcs/dock-v2/airlock/finish", { force: "yes" })).status).toBe(400);
    expect(await (await post(h, "/arcs/dock-v2/airlock/finish")).json()).toEqual({
      kind: "wedged",
      sessions: ["s1"],
    });
    await post(h, "/arcs/dock-v2/airlock/finish", { force: true });
    expect(finishes).toEqual([
      ["dock-v2", { force: false }],
      ["dock-v2", { force: true }],
    ]);
  });
});

describe("docs/events.md server events", () => {
  it("documents every server event under the Server events heading", () => {
    const doc = readFileSync(new URL("../../../docs/events.md", import.meta.url), "utf8");
    const serverSection = doc.split("## Server events")[1] ?? "";
    for (const type of serverEventTypes) expect(serverSection).toContain(`### ${type}`);
  });
});

describe("prompt behavior", () => {
  it("defaults to queue, refuses an unknown behavior, and runs a steer ahead of the queue", async () => {
    const h = harness({ provider: hangingProvider() });
    const id = await createSession(h);
    const reader = await h.stream();
    const post = (body: unknown) =>
      h.call(`/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify(body) });
    expect((await post({ text: "hi", behavior: "sideways" })).status).toBe(400);
    expect(await (await post({ text: "first" })).json()).toEqual({
      sessionId: id,
      accepted: true,
      queued: false,
      behavior: "queue",
    });
    expect((await reader.next()).event).toBe("turn.started");
    expect(await (await post({ text: "patient" })).json()).toMatchObject({
      queued: true,
      behavior: "queue",
    });
    expect(await (await post({ text: "urgent", behavior: "steer" })).json()).toMatchObject({
      queued: true,
      behavior: "steer",
    });
    const steered = await collect(reader, (event) => event === "turn.started");
    expect(steered.map((frame) => frame.event)).toContain("turn.interrupted");
    expect(JSON.parse(steered.at(-1)?.data ?? "{}").payload.userText).toBe("urgent");
    await h.call(`/sessions/${id}/abort`, { method: "POST" });
    const next = await collect(reader, (event) => event === "turn.started");
    expect(JSON.parse(next.at(-1)?.data ?? "{}").payload.userText).toBe("patient");
    await h.call(`/sessions/${id}/abort`, { method: "POST" });
    await reader.close();
  });
});

describe("GET /events?session=", () => {
  function twoSessions(h: Harness) {
    const first = new EventBus<EngineEvents>();
    const second = new EventBus<EngineEvents>();
    h.log.attach(first, "s1");
    h.log.attach(second, "s2");
    return { first, second };
  }

  it("keeps the session's envelopes and the process-level ones, in the replay and live", async () => {
    const h = harness();
    const { first, second } = twoSessions(h);
    first.emit("session.mode", { mode: "one" });
    second.emit("session.mode", { mode: "two" });
    h.log.record("", "gate.preset", { from: "standard", to: "careful" });
    const reader = sseReader(
      await h.call("/events?session=s1", { headers: { "last-event-id": "0" } }),
    );
    expect(JSON.parse((await reader.next()).data)).toMatchObject({ id: 1, sessionId: "s1" });
    expect(JSON.parse((await reader.next()).data)).toMatchObject({ id: 3, sessionId: "" });
    second.emit("session.mode", { mode: "ignored" });
    first.emit("session.mode", { mode: "live" });
    expect(JSON.parse((await reader.next()).data)).toMatchObject({ id: 5, sessionId: "s1" });
    await reader.close();
  });

  it("drops the process-level envelopes too with only=session, and still resumes from Last-Event-ID", async () => {
    const h = harness();
    const { first, second } = twoSessions(h);
    for (const mode of ["a", "b"]) first.emit("session.mode", { mode });
    h.log.record("", "gate.preset", { from: "standard", to: "careful" });
    second.emit("session.mode", { mode: "other" });
    first.emit("session.mode", { mode: "c" });
    const reader = sseReader(
      await h.call("/events?session=s1&only=session", { headers: { "last-event-id": "1" } }),
    );
    expect((await reader.next()).id).toBe("2");
    expect((await reader.next()).id).toBe("5");
    await reader.close();
  });
});

describe("session verbs", () => {
  const post = (h: Harness, path: string, body?: unknown) =>
    h.call(path, {
      method: "POST",
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  const stateOf = async (reader: SseReader) => {
    const frames = await collect(reader, (event) => event === "session.state");
    return JSON.parse(frames.at(-1)?.data ?? "{}") as { sessionId: string; payload: unknown };
  };
  const models = () => ({
    "mock/alpha": new MockProvider([textTurn("from alpha")], "alpha"),
    "mock/beta": new MockProvider([textTurn("from beta")], "beta"),
  });

  it("switches the model, lists it, announces session.state, and refuses what does not resolve", async () => {
    const catalog = models();
    const h = harness({ provider: catalog["mock/alpha"], models: catalog });
    const id = await createSession(h);
    const reader = await h.stream();
    const switched = await post(h, `/sessions/${id}/model`, { reference: "beta" });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({
      model: { provider: "mock", model: "beta" },
      notice: "model → mock/beta",
    });
    expect(await stateOf(reader)).toMatchObject({
      sessionId: id,
      payload: {
        model: "mock/beta",
        thinking: false,
        title: `session ${id}`,
        leafId: null,
        undoable: false,
        redoable: false,
      },
    });
    const listed = (await (await h.call("/sessions")).json()) as { sessions: unknown[] };
    expect(listed.sessions[0]).toMatchObject({ id, model: "mock/beta", thinking: false });

    const unknown = await post(h, `/sessions/${id}/model`, { reference: "gamma" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ failure: { code: "unknown-model" } });
    expect((await post(h, `/sessions/${id}/model`, {})).status).toBe(400);
    expect((await post(h, "/sessions/nope/model", { reference: "beta" })).status).toBe(404);
    await reader.close();
  });

  it("refuses a model switch while a turn runs", async () => {
    const hanging = { ...hangingProvider(), modelId: "slow" };
    const h = harness({ provider: hanging, models: { "hang/slow": hanging } });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "wait" });
    expect((await reader.next()).event).toBe("turn.started");
    const busy = await post(h, `/sessions/${id}/model`, { reference: "slow" });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "a turn is running" });
    await post(h, `/sessions/${id}/abort`);
    await reader.close();
  });

  it("sets thinking and effort, announces each, and refuses unknown words", async () => {
    const h = harness();
    const id = await createSession(h);
    const reader = await h.stream();
    const thinking = await post(h, `/sessions/${id}/thinking`, { on: true });
    expect(await thinking.json()).toEqual({ thinking: true });
    expect(await stateOf(reader)).toMatchObject({ payload: { thinking: true } });
    expect((await post(h, `/sessions/${id}/thinking`, { on: "yes" })).status).toBe(400);
    expect((await post(h, "/sessions/nope/thinking", { on: true })).status).toBe(404);

    const effort = await post(h, `/sessions/${id}/effort`, { level: "high" });
    expect(await effort.json()).toEqual({ effort: "high" });
    expect(await stateOf(reader)).toMatchObject({ payload: { thinking: true, effort: "high" } });
    const reset = await post(h, `/sessions/${id}/effort`, { level: null });
    expect(await reset.json()).toEqual({ effort: null });
    const state = (await stateOf(reader)).payload as { effort?: unknown };
    expect("effort" in state).toBe(false);
    expect((await post(h, `/sessions/${id}/effort`, { level: "turbo" })).status).toBe(400);
    expect((await post(h, `/sessions/${id}/effort`, {})).status).toBe(400);
    expect((await post(h, "/sessions/nope/effort", { level: null })).status).toBe(404);
    await reader.close();
  });

  it("undoes the last prompt handing the text back, stages one level, and redoes it", async () => {
    const h = harness({ provider: new MockProvider([textTurn("sure"), textTurn("again")]) });
    const id = await createSession(h);
    const reader = await h.stream();
    expect((await post(h, `/sessions/${id}/undo`)).status).toBe(404);
    expect((await post(h, `/sessions/${id}/redo`)).status).toBe(404);
    await post(h, `/sessions/${id}/prompt`, { text: "turn on the lights" });
    await collect(reader, (event) => event === "turn.completed");

    const undone = await post(h, `/sessions/${id}/undo`);
    expect(undone.status).toBe(200);
    expect(await undone.json()).toEqual({
      prompt: { entryId: expect.any(String), text: "turn on the lights" },
      filesNote: "files untouched",
      undoable: false,
      redoable: true,
    });
    expect(await stateOf(reader)).toMatchObject({
      payload: { leafId: null, undoable: false, redoable: true },
    });
    const emptied = (await (await h.call(`/sessions/${id}`)).json()) as { messages: Message[] };
    expect(emptied.messages).toEqual([]);
    const staged = await post(h, `/sessions/${id}/undo`);
    expect(staged.status).toBe(409);

    const redone = await post(h, `/sessions/${id}/redo`);
    expect(await redone.json()).toEqual({ restored: true, undoable: true, redoable: false });
    const restored = (await (await h.call(`/sessions/${id}`)).json()) as { messages: Message[] };
    expect(restored.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect((await post(h, `/sessions/${id}/redo`)).status).toBe(404);
    expect((await post(h, "/sessions/nope/undo")).status).toBe(404);
    await reader.close();
  });

  it("refuses undo, redo and compact while a turn runs", async () => {
    const h = harness({ provider: hangingProvider() });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "wait" });
    expect((await reader.next()).event).toBe("turn.started");
    expect((await post(h, `/sessions/${id}/undo`)).status).toBe(409);
    expect((await post(h, `/sessions/${id}/redo`)).status).toBe(409);
    expect((await post(h, `/sessions/${id}/compact`, {})).status).toBe(409);
    await post(h, `/sessions/${id}/abort`);
    await reader.close();
  });

  it("answers compact with the entry and the notices, and validates the focus", async () => {
    const h = harness();
    const id = await createSession(h);
    const compacted = await post(h, `/sessions/${id}/compact`, { focus: "the plan" });
    expect(compacted.status).toBe(200);
    expect(await compacted.json()).toEqual({
      compacted: null,
      notices: ["nothing to compact · this host never compacts"],
    });
    expect((await post(h, `/sessions/${id}/compact`)).status).toBe(200);
    expect((await post(h, `/sessions/${id}/compact`, { focus: 3 })).status).toBe(400);
    expect((await post(h, "/sessions/nope/compact", {})).status).toBe(404);
  });

  it("reads the context gauge and the cost ledger", async () => {
    const provider = new MockProvider(
      [textTurn("costly", { inputTokens: 100, outputTokens: 20 })],
      { modelId: "gpt-5", capabilities: { input: ["text"], toolCalls: true, contextWindow: 1000 } },
    );
    const h = harness({ provider });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "spend" });
    await collect(reader, (event) => event === "turn.completed");
    await reader.close();

    const context = (await (await h.call(`/sessions/${id}/context`)).json()) as Record<
      string,
      unknown
    >;
    expect(context).toMatchObject({
      window: 1000,
      declared: true,
      basis: "estimated",
      flushDue: false,
      compactionDue: false,
    });
    expect(context.used).toBeGreaterThan(0);
    expect(context.fullness).toBeGreaterThan(0);
    const cost = (await (await h.call(`/sessions/${id}/cost`)).json()) as {
      rollup: { pricedTurns: number; nanos: number };
      usage: { inputTokens: number };
      basis: string;
      models: Array<{ reference: string; turns: number }>;
    };
    expect(cost.rollup.pricedTurns).toBe(1);
    expect(cost.rollup.nanos).toBeGreaterThan(0);
    expect(cost.usage.inputTokens).toBe(100);
    expect(cost.basis).toBe("estimated from gpt-5 rates");
    expect(cost.models).toEqual([expect.objectContaining({ reference: "mock/gpt-5", turns: 1 })]);
    expect((await h.call("/sessions/nope/context")).status).toBe(404);
    expect((await h.call("/sessions/nope/cost")).status).toBe(404);
  });

  it("exports the transcript as HTML and validates the scope", async () => {
    const h = harness({ provider: new MockProvider([textTurn("<b>bold</b> reply")]) });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "say something" });
    await collect(reader, (event) => event === "turn.completed");
    await reader.close();
    const exported = await post(h, `/sessions/${id}/export`, { scope: "path" });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await exported.text();
    expect(html).toContain("say something");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; reply");
    expect((await post(h, `/sessions/${id}/export`)).status).toBe(200);
    expect((await post(h, `/sessions/${id}/export`, { scope: "sideways" })).status).toBe(400);
    expect((await post(h, `/sessions/${id}/export`, { out: "x.html" })).status).toBe(403);
    expect((await post(h, "/sessions/nope/export", {})).status).toBe(404);
  });

  it("renames the session, keeps the title in the listing, and announces it", async () => {
    const h = harness();
    const id = await createSession(h);
    const reader = await h.stream();
    const renamed = await post(h, `/sessions/${id}/rename`, { title: "Lights" });
    expect(await renamed.json()).toEqual({ title: "Lights" });
    expect(await stateOf(reader)).toMatchObject({ payload: { title: "Lights" } });
    const listed = (await (await h.call("/sessions")).json()) as { sessions: unknown[] };
    expect(listed.sessions[0]).toMatchObject({ id, title: "Lights" });
    expect((await post(h, `/sessions/${id}/rename`, { title: "  " })).status).toBe(400);
    expect((await post(h, "/sessions/nope/rename", { title: "x" })).status).toBe(404);
    await reader.close();
  });
});

describe("POST /preset", () => {
  const post = (h: Harness, body: unknown) =>
    h.call("/preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("tightens freely, refuses to loosen without confirmed: true, and announces gate.preset process-wide", async () => {
    const h = harness();
    const reader = await h.stream();
    const refused = await post(h, { name: "open" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "loosening needs confirmed: true" });
    const loosened = await post(h, { name: "open", confirmed: true });
    expect(await loosened.json()).toEqual({ from: "standard", to: "open" });
    const announced = await reader.next();
    expect(announced.event).toBe("gate.preset");
    expect(JSON.parse(announced.data)).toMatchObject({
      sessionId: "",
      payload: { from: "standard", to: "open" },
    });
    expect(await (await post(h, { name: "careful" })).json()).toEqual({
      from: "open",
      to: "careful",
    });
    expect(await (await post(h, { name: "careful" })).json()).toEqual({
      from: "careful",
      to: "careful",
    });
    for (const body of [{}, { name: "wild" }, { name: "open", confirmed: false }]) {
      expect((await post(h, body)).status, JSON.stringify(body)).toBe(400);
    }
    await reader.close();
  });
});

describe("tool-output spills", () => {
  const numberedLines = (count: number) =>
    Array.from({ length: count }, (_, index) => `line ${String(index).padStart(5, "0")}`).join(
      "\n",
    );
  const flood = (output: string): Tool => ({
    name: "flood",
    description: "floods",
    parameters: { type: "object" },
    execute: async () => output,
  });
  const spillPath = (id: string, spillId: string, query = "") =>
    `/sessions/${id}/spills/${spillId}${query}`;

  async function spilledSession(output: string) {
    const h = harness({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "flood", arguments: {} }),
        textTurn("done"),
      ]),
      tools: [flood(output)],
    });
    const id = await createSession(h);
    const reader = await h.stream();
    await h.call(`/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "flood" }),
    });
    await collect(reader, (event) => event === "turn.completed");
    await reader.close();
    const { messages } = (await (await h.call(`/sessions/${id}`)).json()) as {
      messages: Message[];
    };
    const spill = spillIn(messages);
    if (spill === undefined) throw new Error("the tool output did not spill");
    return { h, id, spill };
  }

  it("opens the elided region by the reference's own range, and the whole spill without one", async () => {
    const output = numberedLines(8000);
    const { h, id, spill } = await spilledSession(output);
    expect(spill.bytes).toBe(Buffer.byteLength(output));
    const elided = await h.call(
      spillPath(id, spill.id, `?from=${spill.elidedFrom}&to=${spill.elidedTo}`),
    );
    expect(elided.status).toBe(200);
    expect(await elided.json()).toEqual({
      spillId: spill.id,
      bytes: spill.bytes,
      from: spill.elidedFrom,
      to: spill.elidedTo,
      text: output.slice(spill.elidedFrom, spill.elidedTo),
      truncated: false,
      eof: false,
      encoding: "utf-8",
    });
    const whole = (await (await h.call(spillPath(id, spill.id))).json()) as { text: string };
    expect(whole).toMatchObject({ from: 0, to: spill.bytes, truncated: false, eof: true });
    expect(whole.text).toBe(output);
  });

  it("answers 404 for an unknown session or spill and 400 for a range that is not whole numbers", async () => {
    const { h, id, spill } = await spilledSession(numberedLines(8000));
    const unknownSpill = await h.call(spillPath(id, "no-such-spill"));
    expect(unknownSpill.status).toBe(404);
    expect(await unknownSpill.json()).toEqual({ error: "no spill no-such-spill in this session" });
    expect((await h.call(spillPath(id, "..%2F..%2Fescape"))).status).toBe(404);
    const unknownSession = await h.call(spillPath("nope", spill.id));
    expect(unknownSession.status).toBe(404);
    expect(await unknownSession.json()).toEqual({ error: "no session has that id" });
    expect((await h.call(spillPath(id, spill.id, "?from=abc"))).status).toBe(400);
    expect((await h.call(spillPath(id, spill.id, "?to=-1"))).status).toBe(400);
  });

  it("cuts a range to the 1 MiB cap with truncated: true and refuses a slice holding a NUL", async () => {
    const output = `${"a".repeat(maxFileSliceBytes + 4096)}\u0000${"b".repeat(100)}`;
    const { h, id, spill } = await spilledSession(output);
    const capped = await h.call(spillPath(id, spill.id));
    expect(capped.status).toBe(200);
    expect(await capped.json()).toMatchObject({
      from: 0,
      to: maxFileSliceBytes,
      truncated: true,
      eof: false,
    });
    const binary = await h.call(spillPath(id, spill.id, `?from=${maxFileSliceBytes}`));
    expect(binary.status).toBe(415);
    expect(await binary.json()).toEqual({ error: "binary spill" });
  });
});

function spillIn(messages: readonly Message[]): SpillReference | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool-result" && part.spill !== undefined) return part.spill;
    }
  }
  return undefined;
}
