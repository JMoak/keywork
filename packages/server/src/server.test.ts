import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type EngineEvents,
  EventBus,
  IneligibleDeliveryError,
  McpServerNotFoundError,
  type MemoryStore,
  type Message,
  MissingSuccessorError,
  MockProvider,
  type Provider,
  type ProviderRequest,
  type Tool,
  type TurnDelta,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import type { ActivePreset, Flavor } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import type { ChangesSource } from "./changes.ts";
import { keyworkClient } from "./client.ts";
import { type BusEnvelope, type EngineEventType, EventLog, engineEventTypes } from "./events.ts";
import type { ArcAirlockPort, McpPort, PresetHost } from "./host.ts";
import { listen } from "./listen.ts";
import { routes } from "./openapi.ts";
import { fileChangeCapBytes } from "./routes/changes.ts";
import { createKeyworkServer, type KeyworkServer } from "./server.ts";
import {
  type MemorySurfaceOptions,
  memorySessionHost,
  type SseFrame,
  type SseReader,
  sseReader,
  vaultMemoryPort,
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
    surfaces?: MemorySurfaceOptions;
  } = {},
) {
  const log = new EventLog({
    ...(options.capacity !== undefined && { capacity: options.capacity }),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
  });
  const host = memorySessionHost({
    log,
    provider: options.provider ?? new MockProvider([]),
    ...(options.tools !== undefined && { tools: options.tools }),
    ...(options.asks !== undefined && { asks: options.asks }),
    ...(options.askTimeoutMs !== undefined && { askTimeoutMs: options.askTimeoutMs }),
    ...(options.surfaces !== undefined && { surfaces: options.surfaces }),
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
    ask: { tool: "bash", callId: "c2", arguments: { command: "rm x" }, rule: "default" },
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
    for (const envelope of recorded) {
      const frame = await reader.next();
      expect(frame.id).toBe(String(envelope.id));
      expect(frame.event).toBe(envelope.type);
      if (envelope.type === "engine.error") {
        expect(JSON.parse(frame.data)).toEqual({
          ...envelope,
          payload: { error: { name: "Error", message: "boom" } },
        });
      } else {
        expect(frame.data).toBe(JSON.stringify(envelope));
        expect(JSON.parse(frame.data).payload).toEqual(
          samplePayloads[envelope.type as EngineEventType],
        );
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
    let completed = false;
    const frames = await collect(reader, (event) => {
      if (event === "turn.completed") completed = true;
      return completed && event === "session.state";
    });
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

describe("memory (K4)", () => {
  const vaults = scratchDirs("keywork-server-memory-");
  const at = new Date("2026-10-10T12:00:00.000Z");
  const inert = "memory is inert: this workspace is untrusted";

  async function memoryHarness(trusted: boolean, airlock?: ArcAirlockPort) {
    const vaultRoot = await vaults();
    const memory = vaultMemoryPort({
      vaultRoot,
      trusted,
      now: () => at,
      ...(airlock !== undefined && { airlock }),
    });
    const log = new EventLog({ now: () => at });
    const host = memorySessionHost({ log, provider: new MockProvider([]), memory });
    const server = createKeyworkServer({ token, host, log, version: "0.0.1-test" });
    const call = (path: string, init: RequestInit = {}) =>
      server.fetch(
        new Request(`${origin}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        }),
      );
    const post = (path: string, body?: unknown) =>
      call(path, {
        method: "POST",
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
    const client = keyworkClient(
      { url: origin, token },
      { fetch: (input, init) => server.fetch(new Request(input, init)) },
    );
    const inboxEvents = (): BusEnvelope[] =>
      log.since(0).filter((envelope) => envelope.type === "memory.inbox");
    return { vaultRoot, memory, log, server, call, post, client, inboxEvents };
  }

  async function stageNote(memory: { store: MemoryStore }, title: string): Promise<string> {
    await memory.store.writeNote({ title, body: `${title} body\n`, provenance: "untrusted" });
    const staged = await memory.store.listStaged();
    const item = staged.find(
      (candidate) => candidate.kind === "note" && candidate.target === `${title}.md`,
    );
    if (item === undefined) throw new Error(`expected ${title} to be staged`);
    return item.id;
  }

  const reads: Array<[path: string, inert: unknown]> = [
    ["/memory", { trusted: false, layers: [], inbox: [], ledger: [], audit: [], airlocks: [] }],
    ["/memory/inbox", { trusted: false, items: [], count: 0 }],
    ["/memory/notes", { trusted: false, notes: [] }],
    ["/memory/notes?layer=workspace", { trusted: false, notes: [] }],
    ["/memory/notes/Dock%20Rule", { trusted: false }],
    ["/memory/daily", { trusted: false, dates: [] }],
    ["/memory/daily/2026-10-10", { trusted: false, date: "2026-10-10", entries: [] }],
    ["/memory/ledger", { trusted: false, entries: [] }],
    [
      "/arcs/dock-v2/airlock",
      {
        trusted: false,
        arc: "dock-v2",
        candidates: [],
        questions: [],
        decisions: { candidates: {}, questions: {} },
      },
    ],
  ];

  const writes: Array<[path: string, body?: unknown]> = [
    ["/memory/inbox/x/approve"],
    ["/memory/inbox/x/discard"],
    ["/memory/ledger/x/revert"],
    ["/arcs/dock-v2/airlock/candidates/Dock%20Rule", { choice: "deliver" }],
    ["/arcs/dock-v2/airlock/questions", { title: "Tie order", choice: "drop" }],
    ["/arcs/dock-v2/airlock/deliver"],
    ["/arcs/dock-v2/airlock/finish", { force: true }],
  ];

  it("answers the inert shape on every read and 403 on every write against an untrusted vault", async () => {
    const h = await memoryHarness(false);
    for (const [path, shape] of reads) {
      const response = await h.call(path);
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toEqual(shape);
    }
    const asked = await h.post("/memory/ask", { query: "dock" });
    expect(await asked.json()).toEqual({ trusted: false, hits: [], source: "lexical" });
    for (const [path, body] of writes) {
      const response = await h.post(path, body);
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({ error: inert });
    }
    expect(h.inboxEvents()).toEqual([]);
  });

  it("answers 503 when the host serves no memory at all", async () => {
    const h = harness();
    expect((await h.call("/memory")).status).toBe(503);
    expect((await h.call("/memory/inbox/x/approve", { method: "POST" })).status).toBe(503);
  });

  it("answers the live shape against a trusted vault with engine records, not pane views", async () => {
    const h = await memoryHarness(true);
    const written = await h.memory.store.writeNote({
      title: "Dock Rule",
      body: "two docks max\n",
      provenance: "user",
    });
    await h.memory.store.writeMoc(["Dock Rule"], "user");
    await h.memory.store.appendDaily("learned the dock rule", "agent", "s1");
    await stageNote(h.memory, "Hunch");

    const overview = (await (await h.call("/memory")).json()) as {
      trusted: boolean;
      layers: unknown[];
      inbox: Array<{ kind: string; target: string }>;
      ledger: Array<{ id: string; op: string }>;
      audit: unknown[];
      gardener: unknown;
      airlocks: unknown[];
    };
    expect(overview.trusted).toBe(true);
    expect(overview.layers).toEqual([
      {
        id: "workspace",
        kind: "workspace",
        label: "workspace",
        prompt: { budget: 4096, used: expect.any(Number) },
      },
    ]);
    expect(overview.inbox).toEqual([expect.objectContaining({ kind: "note", target: "Hunch.md" })]);
    expect(overview.ledger.map((entry) => entry.op)).toEqual([
      "create",
      "create",
      "create",
      "create",
    ]);
    expect(overview.ledger[0]?.id).toBe(written.ledgerId);
    expect(overview.gardener).toEqual({ state: "idle" });
    expect(overview.airlocks).toEqual([]);

    const notes = (await (await h.call("/memory/notes")).json()) as {
      trusted: boolean;
      notes: Array<Record<string, unknown>>;
    };
    expect(notes.notes).toEqual([
      expect.objectContaining({
        name: "Dock Rule",
        path: "Dock Rule.md",
        provenance: "user",
        layer: "workspace",
        file: join(h.vaultRoot, "Dock Rule.md"),
        curing: 3,
        injected: true,
        recalls: 0,
        body: "two docks max\n",
      }),
    ]);
    expect((await (await h.call("/memory/notes?layer=arc:none")).json()) as object).toEqual({
      trusted: true,
      notes: [],
    });
    const note = await h.call("/memory/notes/Dock%20Rule");
    expect(await note.json()).toMatchObject({ trusted: true, name: "Dock Rule", relations: [] });
    expect((await h.call("/memory/notes/Nope")).status).toBe(404);

    expect(await (await h.call("/memory/daily")).json()).toEqual({
      trusted: true,
      dates: ["2026-10-10"],
    });
    expect(await (await h.call("/memory/daily/2026-10-10")).json()).toEqual({
      trusted: true,
      date: "2026-10-10",
      entries: [
        { time: "12:00", provenance: "agent", text: "learned the dock rule", session: "s1" },
      ],
    });
    expect((await h.call("/memory/daily/yesterday")).status).toBe(400);

    const ledger = (await (await h.call("/memory/ledger")).json()) as { entries: unknown[] };
    expect(ledger.entries).toEqual(h.memory.store.ledger());

    const asked = (await (await h.post("/memory/ask", { query: "docks" })).json()) as {
      trusted: boolean;
      hits: Array<{ note: string; layer: string }>;
      source: string;
    };
    expect(asked).toMatchObject({ trusted: true, source: "lexical" });
    expect(asked.hits.map((hit) => [hit.note, hit.layer])).toEqual([["Dock Rule", "workspace"]]);
    expect((await h.post("/memory/ask", { arc: "x" })).status).toBe(400);
  });

  it("approve writes the note and fires memory.inbox with the decremented count; discard empties it", async () => {
    const h = await memoryHarness(true);
    const first = await stageNote(h.memory, "First Hunch");
    const second = await stageNote(h.memory, "Second Hunch");
    expect(await (await h.call("/memory/inbox")).json()).toMatchObject({ trusted: true, count: 2 });

    const approved = await h.post(`/memory/inbox/${first}/approve`);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({
      path: "First Hunch.md",
      staged: false,
      ledgerId: expect.any(String),
    });
    expect(await h.memory.store.readNote("First Hunch")).toMatchObject({ provenance: "untrusted" });
    expect(h.inboxEvents()).toEqual([
      expect.objectContaining({
        sessionId: "",
        type: "memory.inbox",
        payload: { count: 1, staged: 1, airlock: 0, proposals: 0, contradictions: 0 },
      }),
    ]);

    const discarded = await h.post(`/memory/inbox/${second}/discard`);
    expect(await discarded.json()).toEqual({});
    expect(h.inboxEvents().at(-1)?.payload).toEqual({
      count: 0,
      staged: 0,
      airlock: 0,
      proposals: 0,
      contradictions: 0,
    });
    expect(await h.memory.store.listStaged()).toEqual([]);

    const missing = await h.post(`/memory/inbox/${first}/approve`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: `no staged item with id ${first}` });
  });

  it("passes drift-review and forget-proposal through as StagedItem with no server-side switch", async () => {
    const h = await memoryHarness(true);
    await h.memory.store.propose([
      {
        kind: "drift-review",
        note: "Dock Rule",
        against: "abc123",
        reason: "the dock count changed",
        evidence: ["packages/tui/src/layout.ts"],
      },
      { kind: "forget-proposal", session: "s9", notes: ["Hunch"], entries: ["2026-10-10#0"] },
      {
        kind: "contradiction",
        a: "Dock Rule",
        b: "Old Dock Rule",
        aProvenance: "user",
        bProvenance: "agent",
        confidence: 0.8,
      },
    ]);
    const listed = (await (await h.call("/memory/inbox")).json()) as {
      items: unknown[];
      count: number;
    };
    expect(listed.items).toEqual(JSON.parse(JSON.stringify(await h.memory.store.listStaged())));
    expect(listed.count).toBe(3);
    await stageNote(h.memory, "Hunch");
    h.memory.changed();
    await until(() => h.inboxEvents().length === 1);
    expect(h.inboxEvents()[0]?.payload).toEqual({
      count: 4,
      staged: 1,
      airlock: 0,
      proposals: 2,
      contradictions: 1,
    });
    h.memory.changed();
    await settle();
    expect(h.inboxEvents()).toHaveLength(1);
  });

  it("revert answers needs-rebase after an outside edit and reverted when the file still matches", async () => {
    const h = await memoryHarness(true);
    const written = await h.memory.store.writeNote({
      title: "Dock Rule",
      body: "two docks max\n",
      provenance: "agent",
    });
    await writeFile(join(h.vaultRoot, "Dock Rule.md"), "edited outside keywork\n");
    const stale = await h.post(`/memory/ledger/${written.ledgerId}/revert`);
    expect(await stale.json()).toEqual({ outcome: "needs-rebase" });

    const again = await h.memory.store.writeNote({
      title: "Dock Rule",
      body: "three docks max\n",
      provenance: "agent",
    });
    expect(await (await h.post(`/memory/ledger/${again.ledgerId}/revert`)).json()).toEqual({
      outcome: "reverted",
    });
    expect(await readFile(join(h.vaultRoot, "Dock Rule.md"), "utf8")).toBe(
      "edited outside keywork\n",
    );
    const missing = await h.post("/memory/ledger/nope/revert");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no ledger entry with id nope" });
  });

  it("drives the airlock port over HTTP with its digest, triage, deliver and finish verbs", async () => {
    const airlock = scriptedAirlock();
    const h = await memoryHarness(true, airlock);
    expect((await h.call("/arcs/none/airlock")).status).toBe(404);
    const digest = (await (await h.call("/arcs/dock-v2/airlock")).json()) as {
      trusted: boolean;
      decisions: unknown;
      candidates: Array<{ note: string; eligible: boolean }>;
    };
    expect(digest.trusted).toBe(true);
    expect(digest.candidates.map((c) => [c.note, c.eligible])).toEqual([
      ["Dock Ratio Finding", true],
      ["Uncited Hunch", false],
    ]);
    expect(digest.decisions).toEqual({ candidates: {}, questions: {}, successor: "next-arc" });

    const bad = await h.post("/arcs/dock-v2/airlock/candidates/Dock%20Ratio%20Finding", {
      choice: "keep",
    });
    expect(bad.status).toBe(400);
    const unknown = await h.post("/arcs/dock-v2/airlock/candidates/Ghost", { choice: "leave" });
    expect(unknown.status).toBe(404);
    const below = await h.post("/arcs/dock-v2/airlock/candidates/Uncited%20Hunch", {
      choice: "deliver",
    });
    expect(below.status).toBe(409);
    expect(await below.json()).toEqual({
      error: '"Uncited Hunch" is below the delivery bar (uncited); it stays archived',
    });
    const decided = (await (
      await h.post("/arcs/dock-v2/airlock/candidates/Dock%20Ratio%20Finding", {
        choice: "deliver",
      })
    ).json()) as { decisions: { candidates: Record<string, string> } };
    expect(decided.decisions.candidates).toEqual({ "Dock Ratio Finding": "deliver" });

    const noQuestion = await h.post("/arcs/dock-v2/airlock/questions", {
      title: "Nope",
      choice: "drop",
    });
    expect(noQuestion.status).toBe(404);
    airlock.successor = undefined;
    const orphan = await h.post("/arcs/dock-v2/airlock/questions", {
      title: "Tie order",
      choice: "carry",
    });
    expect(orphan.status).toBe(409);
    airlock.successor = "next-arc";
    const carried = (await (
      await h.post("/arcs/dock-v2/airlock/questions", { title: "Tie order", choice: "carry" })
    ).json()) as { decisions: { questions: Record<string, string>; successor?: string } };
    expect(carried.decisions).toMatchObject({
      questions: { "Tie order": "carry" },
      successor: "next-arc",
    });

    expect(await (await h.post("/arcs/dock-v2/airlock/deliver")).json()).toEqual({ delivered: 1 });
    expect(await (await h.post("/arcs/dock-v2/airlock/finish")).json()).toEqual({
      kind: "undecided",
      items: ["Theme drift"],
    });
    await h.post("/arcs/dock-v2/airlock/questions", { title: "Theme drift", choice: "drop" });
    expect(await (await h.post("/arcs/dock-v2/airlock/finish", { force: true })).json()).toEqual({
      kind: "closed",
      delivered: 1,
      released: 2,
    });
    expect(airlock.forced).toBe(true);
    expect((await h.call("/arcs/dock-v2/airlock")).status).toBe(404);
    expect((await h.post("/arcs/dock-v2/airlock/deliver")).status).toBe(404);
    expect(h.inboxEvents().length).toBeGreaterThan(0);
    for (const envelope of h.inboxEvents()) expect(envelope.sessionId).toBe("");
  });

  it("reads the same records through the typed client", async () => {
    const h = await memoryHarness(true, scriptedAirlock());
    await h.memory.store.writeNote({ title: "Dock Rule", body: "docks\n", provenance: "user" });
    const id = await stageNote(h.memory, "Hunch");
    expect((await h.client.memory()).layers.map((layer) => layer.id)).toEqual(["workspace"]);
    expect((await h.client.memoryInbox()).count).toBe(1);
    expect(await h.client.approveStagedItem(id)).toMatchObject({ path: "Hunch.md" });
    expect((await h.client.memoryNotes()).notes.map((note) => note.name).sort()).toEqual([
      "Dock Rule",
      "Hunch",
    ]);
    expect((await h.client.memoryNote("Dock Rule"))?.curing).toBe(3);
    expect(await h.client.memoryNote("Nope")).toBeUndefined();
    expect((await h.client.memoryDailyDates()).dates).toEqual([]);
    expect((await h.client.memoryLedger()).entries).toHaveLength(3);
    expect((await h.client.askMemory("docks")).hits[0]?.note).toBe("Dock Rule");
    expect(await h.client.airlock("none")).toBeUndefined();
    expect((await h.client.airlock("dock-v2"))?.arc).toBe("dock-v2");
    expect(await h.client.deliverAirlock("dock-v2")).toEqual({ delivered: 1 });
    await expect(h.client.revertMemoryLedgerEntry("nope")).rejects.toThrow(
      "no ledger entry with id nope",
    );
    const untrusted = await memoryHarness(false);
    expect(await untrusted.client.memory()).toMatchObject({ trusted: false });
    await expect(untrusted.client.discardStagedItem("x")).rejects.toThrow(inert);
  });

  async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("the condition never held");
      await settle();
    }
  }

  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 25));
  }

  interface ScriptedAirlock extends ArcAirlockPort {
    successor: string | undefined;
    forced: boolean;
  }

  function scriptedAirlock(): ScriptedAirlock {
    const candidates = new Map<string, "deliver" | "leave">();
    const questions = new Map<string, "resolve" | "carry" | "drop">();
    const titles = ["Tie order", "Theme drift"];
    const eligible = new Map([
      ["Dock Ratio Finding", true],
      ["Uncited Hunch", false],
    ]);
    let open = true;
    const port: ScriptedAirlock = {
      successor: "next-arc",
      forced: false,
      digest: async (slug) => {
        if (slug !== "dock-v2" || !open) return undefined;
        return {
          arc: slug,
          candidates: [...eligible].map(([note, ok]) => {
            const choice = candidates.get(note);
            return {
              note,
              title: note,
              provenance: "agent" as const,
              eligible: ok,
              shortfalls: ok ? [] : ["uncited"],
              ...(choice !== undefined && { choice }),
            };
          }),
          questions: titles.map((title) => {
            const choice = questions.get(title);
            return {
              title,
              provenance: "user" as const,
              ...(choice !== undefined && { choice }),
            };
          }),
          ...(port.successor !== undefined && { successor: port.successor }),
          sweep: { acked: 2, wedged: 0 },
        };
      },
      triageCandidate: async (slug, note, choice) => {
        if (choice === "deliver" && eligible.get(note) !== true)
          throw new IneligibleDeliveryError(slug, note, ["uncited"]);
        candidates.set(note, choice);
      },
      triageQuestion: async (slug, title, choice) => {
        if (choice === "carry" && port.successor === undefined)
          throw new MissingSuccessorError(slug);
        questions.set(title, choice);
      },
      deliverEligible: async () => {
        let delivered = 0;
        for (const [note, ok] of eligible) {
          candidates.set(note, ok ? "deliver" : "leave");
          if (ok) delivered += 1;
        }
        return delivered;
      },
      finish: async (_slug, options = {}) => {
        const undecided = [
          ...[...eligible.keys()].filter((note) => !candidates.has(note)),
          ...titles.filter((title) => !questions.has(title)),
        ];
        if (undecided.length > 0) return { kind: "undecided", items: undecided };
        port.forced = options.force === true;
        open = false;
        return { kind: "closed", delivered: 1, released: 2 };
      },
    };
    return port;
  }
});

describe("workspace, files, trust and status (K3)", () => {
  const roots = scratchDirs("keywork-surfaces-");
  const post = (h: Harness, path: string, body?: unknown) =>
    h.call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const bodyOf = async <Shape>(response: Response, status = 200): Promise<Shape> => {
    expect(response.status).toBe(status);
    return (await response.json()) as Shape;
  };
  const surfaceEvents = async (h: Harness, kind: string): Promise<BusEnvelope[]> => {
    const reader = await h.stream(0);
    const seen: BusEnvelope[] = [];
    const latest = h.log.latestId();
    for (;;) {
      const frame = await reader.next();
      const envelope = JSON.parse(frame.data) as BusEnvelope;
      if (
        envelope.type === "surface.changed" &&
        (envelope.payload as { kind: string }).kind === kind
      )
        seen.push(envelope);
      if (envelope.id >= latest) break;
    }
    await reader.close();
    return seen;
  };
  async function populatedRoot(): Promise<string> {
    const root = await roots();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "build/\n");
    await writeFile(join(root, ".hidden"), "");
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "build", "out.js"), "var a = 1;\n");
    await writeFile(join(root, "notes.txt"), "hello world");
    await writeFile(join(root, "big.txt"), Buffer.alloc(1024 * 1024 + 10, 0x61));
    await writeFile(join(root, "bin.dat"), Buffer.from([0x68, 0x69, 0x00, 0x21]));
    return root;
  }

  it("answers 503 on every surface route when the host serves none", async () => {
    const h = harness();
    for (const path of [
      "/workspace",
      "/tree",
      "/files?path=x",
      "/mcp",
      "/arcs",
      "/bots",
      "/workspaces",
      "/flavors",
    ]) {
      expect((await h.call(path)).status, path).toBe(503);
    }
    expect((await post(h, "/workspace/trust")).status).toBe(503);
  });

  it("reports the workspace with the identity /doc names and its readiness", async () => {
    const root = await roots();
    const workspace = { anchor: root, identity: "k3-identity" };
    const h = harness({ workspace, surfaces: { root, identity: workspace.identity } });
    const doc = (await (await h.server.fetch(new Request(`${origin}/doc`))).json()) as {
      info: { workspace: { identity: string } };
    };
    const report = await bodyOf<{
      anchor: { root: string; source: string };
      identity: string;
      declared: boolean;
      trust: string;
      readiness: string;
    }>(await h.call("/workspace"));
    expect(report.identity).toBe(doc.info.workspace.identity);
    expect(report.anchor).toEqual({ root, source: "launch" });
    expect(report).toMatchObject({ declared: false, trust: "undecided", readiness: "undecided" });
  });

  it("lists one directory level, flags ignored and hidden entries, and confines paths", async () => {
    const root = await populatedRoot();
    const h = harness({ surfaces: { root } });
    const listing = await bodyOf<{ path: string; entries: Array<Record<string, unknown>> }>(
      await h.call("/tree"),
    );
    expect(listing.path).toBe("");
    expect(listing.entries).toEqual([
      { name: "build", kind: "dir", ignored: true, hidden: false },
      { name: "src", kind: "dir", ignored: false, hidden: false },
      { name: "big.txt", kind: "file", ignored: false, hidden: false },
      { name: "bin.dat", kind: "file", ignored: false, hidden: false },
      { name: "notes.txt", kind: "file", ignored: false, hidden: false },
    ]);
    const withHidden = await bodyOf<{ entries: Array<{ name: string; hidden: boolean }> }>(
      await h.call("/tree?hidden=true"),
    );
    expect(withHidden.entries.filter((entry) => entry.hidden).map((entry) => entry.name)).toEqual([
      ".gitignore",
      ".hidden",
    ]);
    const inside = await bodyOf<{
      path: string;
      entries: Array<{ name: string; ignored: boolean }>;
    }>(await h.call("/tree?path=build"));
    expect(inside).toEqual({
      path: "build",
      entries: [{ name: "out.js", kind: "file", ignored: true, hidden: false }],
    });
    expect((await h.call("/tree?path=..")).status).toBe(403);
    expect((await h.call(`/tree?path=${encodeURIComponent(join(root, ".."))}`)).status).toBe(403);
    expect((await h.call("/tree?path=nowhere")).status).toBe(404);
  });

  it("slices files by byte range, caps a slice at 1 MiB, and refuses binary content", async () => {
    const root = await populatedRoot();
    const h = harness({ surfaces: { root } });
    expect(await bodyOf(await h.call("/files?path=notes.txt&from=6&to=11"))).toEqual({
      path: "notes.txt",
      bytes: 11,
      from: 6,
      to: 11,
      text: "world",
      truncated: false,
      encoding: "utf-8",
    });
    const whole = await bodyOf<{ text: string; to: number; truncated: boolean }>(
      await h.call("/files?path=notes.txt"),
    );
    expect(whole).toMatchObject({ text: "hello world", to: 11, truncated: false });
    const capped = await bodyOf<{ bytes: number; to: number; text: string; truncated: boolean }>(
      await h.call("/files?path=big.txt"),
    );
    expect(capped).toMatchObject({ bytes: 1024 * 1024 + 10, to: 1024 * 1024, truncated: true });
    expect(capped.text).toHaveLength(1024 * 1024);
    const rest = await bodyOf<{ from: number; to: number; text: string; truncated: boolean }>(
      await h.call(`/files?path=big.txt&from=${capped.to}`),
    );
    expect(rest).toMatchObject({ from: 1024 * 1024, to: 1024 * 1024 + 10, truncated: false });
    expect(rest.text).toBe("a".repeat(10));
    expect((await h.call("/files?path=bin.dat")).status).toBe(415);
    expect((await h.call("/files?path=notes.txt&from=abc")).status).toBe(400);
    expect((await h.call("/files?path=missing.txt")).status).toBe(404);
    expect((await h.call("/files?path=../outside.txt")).status).toBe(403);
    expect((await h.call("/files?path=src")).status).toBe(404);
  });

  it("trusts the served root only, says the server must reopen, and refuses an untrusted root", async () => {
    const root = await roots();
    const h = harness({ surfaces: { root } });
    const grant = await bodyOf(await post(h, "/workspace/trust", { path: "C:/elsewhere" }));
    expect(grant).toEqual({
      trusted: true,
      root,
      vault: join(root, ".keywork", "memory"),
      reopens: true,
    });
    expect(await bodyOf(await h.call("/workspace"))).toMatchObject({
      trust: "trusted",
      readiness: "undeclared",
    });
    const announced = await surfaceEvents(h, "workspaces");
    expect(announced).toHaveLength(1);
    expect(announced[0]?.sessionId).toBe("");
    const refused = harness({ surfaces: { root, trust: "untrusted" } });
    expect((await post(refused, "/workspace/trust")).status).toBe(409);
    expect(await bodyOf(await refused.call("/workspace"))).toMatchObject({ readiness: "refused" });
  });

  it("lists, restarts, toggles and inspects MCP servers, announcing each change", async () => {
    const root = await roots();
    const registry = fakeRegistry();
    const h = harness({ surfaces: { root, mcp: registry.port } });
    expect(await bodyOf(await h.call("/mcp"))).toEqual({ servers: [registry.status()] });
    const restarted = await bodyOf(await post(h, "/mcp/fixture/restart"));
    expect(restarted).toMatchObject({ name: "fixture", state: "connected" });
    expect(registry.calls).toEqual(["restart"]);
    const off = await bodyOf(await post(h, "/mcp/fixture/enabled", { on: false }));
    expect(off).toMatchObject({ enabled: false, state: "down" });
    expect((await post(h, "/mcp/fixture/enabled", { on: "yes" })).status).toBe(400);
    const on = await bodyOf(await post(h, "/mcp/fixture/enabled", { on: true }));
    expect(on).toMatchObject({ enabled: true, state: "connected" });
    expect(await bodyOf(await h.call("/mcp/fixture/tools"))).toEqual({ tools: ["echo", "add"] });
    expect((await h.call("/mcp/nope/tools")).status).toBe(404);
    expect((await post(h, "/mcp/nope/restart")).status).toBe(404);
    expect(await surfaceEvents(h, "mcp")).toHaveLength(3);
  });

  it("lists arcs with ordinals, creates, binds sessions, closes and abandons, announcing each", async () => {
    const root = await roots();
    const h = harness({ provider: new MockProvider([]), surfaces: { root, trust: "trusted" } });
    expect(await bodyOf(await h.call("/arcs"))).toEqual({ arcs: [], ordinals: {} });
    expect((await post(h, "/arcs", { slug: "Bad Slug" })).status).toBe(400);
    const alpha = await bodyOf<{ slug: string; status: string }>(
      await post(h, "/arcs", { slug: "alpha" }),
      201,
    );
    expect(alpha).toMatchObject({ slug: "alpha", status: "active", sessions: 0 });
    expect((await post(h, "/arcs", { slug: "alpha" })).status).toBe(409);
    await post(h, "/arcs", { slug: "beta" });
    const id = await createSession(h);
    expect(await bodyOf(await post(h, `/sessions/${id}/arc`, { slug: "alpha" }))).toEqual({
      arc: "alpha",
    });
    expect((await post(h, "/sessions/nope/arc", { slug: "alpha" })).status).toBe(404);
    expect((await post(h, `/sessions/${id}/arc`, {})).status).toBe(400);
    const listed = await bodyOf<{
      arcs: Array<{ slug: string; sessions: number }>;
      ordinals: Record<string, number>;
    }>(await h.call("/arcs"));
    expect(listed.arcs.map((arc) => [arc.slug, arc.sessions])).toEqual([
      ["alpha", 1],
      ["beta", 0],
    ]);
    expect(listed.ordinals).toEqual({ alpha: 0, beta: 1 });
    expect(
      await bodyOf(await post(h, "/arcs/alpha/close", { direction: "keep the api notes" })),
    ).toEqual({
      kind: "closed",
      delivered: 0,
      released: 1,
    });
    expect((await post(h, "/arcs/alpha/close")).status).toBe(409);
    expect((await post(h, "/arcs/nope/abandon")).status).toBe(404);
    expect(await bodyOf(await post(h, "/arcs/beta/abandon"))).toEqual({
      slug: "beta",
      abandoned: true,
    });
    expect(await bodyOf(await post(h, `/sessions/${id}/arc`, { slug: null }))).toEqual({});
    expect((await surfaceEvents(h, "arcs")).length).toBeGreaterThanOrEqual(5);
    const untrusted = harness({ surfaces: { root } });
    expect((await untrusted.call("/arcs")).status).toBe(403);
    expect((await post(untrusted, "/arcs", { slug: "gamma" })).status).toBe(403);
  });

  it("lists and creates bots and binds a session to one unless a turn is running", async () => {
    const root = await roots();
    const h = harness({ provider: hangingProvider(), surfaces: { root, trust: "trusted" } });
    expect(await bodyOf(await h.call("/bots"))).toEqual({ bots: [] });
    const scribe = await bodyOf(
      await post(h, "/bots", { slug: "scribe", scope: "project", purpose: "writes" }),
      201,
    );
    expect(scribe).toEqual({
      name: "scribe",
      sigil: "S",
      source: "project",
      learning: "notes",
      description: "writes",
    });
    expect((await post(h, "/bots", { slug: "scribe", scope: "project" })).status).toBe(409);
    expect((await post(h, "/bots", { slug: "other", scope: "global" })).status).toBe(400);
    expect((await post(h, "/bots", { slug: "other", scope: "user", purpose: " " })).status).toBe(
      400,
    );
    expect(await bodyOf<{ bots: unknown[] }>(await h.call("/bots"))).toEqual({
      bots: [expect.objectContaining({ name: "scribe", sessions: 0 })],
    });
    const id = await createSession(h);
    expect(await bodyOf(await post(h, `/sessions/${id}/bot`, { name: "scribe" }))).toEqual({
      bot: "scribe",
    });
    expect((await post(h, `/sessions/${id}/bot`, { name: "ghost" })).status).toBe(409);
    expect((await post(h, "/sessions/nope/bot", { name: "scribe" })).status).toBe(404);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "wait" });
    await collect(reader, (event) => event === "turn.started");
    await reader.close();
    const busy = await post(h, `/sessions/${id}/bot`, { name: null });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "a turn is running" });
    await post(h, `/sessions/${id}/abort`);
    expect(await surfaceEvents(h, "bots")).toHaveLength(2);
    const untrusted = harness({ surfaces: { root } });
    expect((await post(untrusted, "/bots", { slug: "scribe", scope: "project" })).status).toBe(403);
    expect((await post(untrusted, "/bots", { slug: "scribe", scope: "user" })).status).toBe(201);
  });

  it("lists, creates, focuses and unfocuses workspaces and remembers which to open next", async () => {
    const root = await roots();
    const h = harness({ surfaces: { root } });
    expect(await bodyOf(await h.call("/workspaces"))).toEqual({
      workspaces: [expect.objectContaining({ name: "default", current: true, focusDirs: [] })],
    });
    expect(await bodyOf(await post(h, "/workspaces", { slug: "docs" }), 201)).toEqual({
      slug: "docs",
    });
    expect((await post(h, "/workspaces", { slug: "default" })).status).toBe(400);
    expect((await post(h, "/workspaces", { slug: "docs" })).status).toBe(409);
    expect(await bodyOf(await post(h, "/workspaces/docs/focus", { dir: "packages/docs" }))).toEqual(
      { dir: "packages/docs" },
    );
    expect((await post(h, "/workspaces/docs/focus", { dir: "packages/docs" })).status).toBe(409);
    expect((await post(h, "/workspaces/docs/focus", {})).status).toBe(400);
    await post(h, "/workspaces/default/focus", { dir: "src" });
    const listed = await bodyOf<{ workspaces: Array<{ slug?: string; focusDirs: string[] }> }>(
      await h.call("/workspaces"),
    );
    expect(listed.workspaces.map((choice) => [choice.slug, choice.focusDirs])).toEqual([
      [undefined, ["src"]],
      ["docs", ["packages/docs"]],
    ]);
    expect(await bodyOf(await post(h, "/workspaces/default/unfocus", { dir: "src" }))).toEqual({
      dir: "src",
    });
    expect((await post(h, "/workspaces/default/unfocus", { dir: "src" })).status).toBe(409);
    expect(await bodyOf(await post(h, "/workspaces/use", { slug: "docs" }))).toEqual({
      slug: "docs",
      reopens: true,
    });
    expect(await bodyOf(await post(h, "/workspaces/use", { slug: null }))).toEqual({
      slug: null,
      reopens: true,
    });
    expect((await post(h, "/workspaces/use", { slug: "nope" })).status).toBe(409);
    expect((await post(h, "/workspaces/use", {})).status).toBe(400);
    expect(await surfaceEvents(h, "workspaces")).toHaveLength(6);
  });

  it("lists the flavor closet with the active name", async () => {
    const root = await roots();
    const h = harness({ surfaces: { root, flavors: [testFlavor] } });
    expect(await bodyOf(await h.call("/flavors"))).toEqual({
      flavors: [testFlavor],
      active: "test-dusk",
    });
  });

  it("drives every surface through the typed client", async () => {
    const root = await populatedRoot();
    const h = harness({ surfaces: { root, trust: "trusted", flavors: [testFlavor] } });
    const client = keyworkClient(
      { url: origin, token },
      { fetch: (input, init) => h.server.fetch(new Request(input, init)) },
    );
    expect((await client.workspace()).anchor.root).toBe(root);
    expect((await client.tree("src")).entries.map((entry) => entry.name)).toEqual(["a.ts"]);
    expect((await client.file("notes.txt", { from: 0, to: 5 })).text).toBe("hello");
    expect(await client.createArc("alpha")).toMatchObject({ slug: "alpha" });
    expect((await client.arcs()).ordinals).toEqual({ alpha: 0 });
    expect(await client.closeArc("alpha")).toMatchObject({ kind: "closed" });
    await client.abandonArc("alpha").catch((cause: unknown) => {
      expect(cause).toMatchObject({ status: 409 });
    });
    expect(await client.createBot({ slug: "scribe", scope: "user" })).toMatchObject({
      name: "scribe",
    });
    expect((await client.bots()).map((bot) => bot.name)).toEqual(["scribe"]);
    const id = await createSession(h);
    expect(await client.bindSessionBot(id, "scribe")).toEqual({ bot: "scribe" });
    expect(await client.bindSessionArc("nope", null)).toBeUndefined();
    await client.createWorkspace("docs");
    expect(await client.focusWorkspaceDir("docs", "packages/docs")).toBe("packages/docs");
    await client.unfocusWorkspaceDir("docs", "packages/docs");
    expect((await client.workspaces()).map((choice) => choice.slug)).toEqual([undefined, "docs"]);
    expect(await client.useWorkspace("docs")).toEqual({ slug: "docs", reopens: true });
    expect((await client.flavors()).active).toBe("test-dusk");
    expect(await client.mcpServers()).toEqual([]);
    await expect(client.restartMcpServer("nope")).rejects.toMatchObject({ status: 404 });
    expect(await client.trustWorkspace()).toMatchObject({ trusted: true, reopens: false });
  });
});

function fakeRegistry() {
  let state: "connected" | "down" = "connected";
  let enabled = true;
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const status = () => ({
    name: "fixture",
    state,
    enabled,
    toolCount: state === "connected" ? 2 : 0,
    transport: "stdio" as const,
  });
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const port: McpPort = {
    status: async () => [status()],
    restart: async (name) => {
      if (name !== "fixture") throw new McpServerNotFoundError(name);
      calls.push("restart");
      state = "connected";
      enabled = true;
      notify();
    },
    setEnabled: async (name, on) => {
      if (name !== "fixture") throw new McpServerNotFoundError(name);
      enabled = on;
      state = on ? "connected" : "down";
      notify();
    },
    listTools: async (name) => {
      if (name !== "fixture") throw new McpServerNotFoundError(name);
      return state === "connected" ? ["echo", "add"] : [];
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { port, calls, status };
}

const testFlavor: Flavor = {
  name: "test-dusk",
  appearance: "dark",
  tokens: {
    background: "#101418",
    panel: "#182028",
    panelLift: "#202a34",
    text: "#f0f4f8",
    textMid: "#b0bcc8",
    textDim: "#7a8694",
    border: "#2a3440",
    borderFocus: "#8ab4f8",
    accent: "#8ab4f8",
    accentSoft: "#5a7aa8",
    success: "#9ad48a",
    error: "#f28b82",
    ramp: ["#8ab4f8"],
  },
  density: { light: "textDim", medium: "textMid", heavy: "text", full: "accent" },
  gap: 0,
  chromeWeight: "seams",
  instruments: "calm",
};

describe("session verbs (118 K1) over the memory host", () => {
  interface VerbHarness extends Harness {
    host: ReturnType<typeof memorySessionHost>;
  }

  function verbHarness(
    options: {
      provider?: Provider;
      tools?: readonly Tool[];
      models?: Readonly<Record<string, Provider>>;
      presets?: PresetHost;
    } = {},
  ): VerbHarness {
    const log = new EventLog({ now: () => new Date("2026-10-10T09:00:00.000Z") });
    const host = memorySessionHost({
      log,
      provider: options.provider ?? new MockProvider([]),
      ...(options.tools !== undefined && { tools: options.tools }),
      ...(options.models !== undefined && { models: options.models }),
      ...(options.presets !== undefined && { presets: options.presets }),
    });
    const server = createKeyworkServer({ token, host, log, version: "0.0.1-test" });
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
    return { server, log, call, stream, host };
  }

  const post = (h: Harness, path: string, body?: unknown) =>
    h.call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const payloadOf = (frame: SseFrame) => JSON.parse(frame.data).payload;
  const stateAfter = async (reader: SseReader) =>
    payloadOf((await collect(reader, (event) => event === "session.state")).at(-1) as SseFrame);
  const messagesOf = async (h: Harness, id: string) =>
    ((await (await h.call(`/sessions/${id}`)).json()) as { messages: Message[] }).messages;

  function hangingThenScripted(turns: TurnDelta[][]): Provider {
    const scripted = new MockProvider(turns);
    let first = true;
    const hanging = hangingProvider();
    return {
      name: "mock",
      stream: (request) => {
        if (!first) return scripted.stream(request);
        first = false;
        return hanging.stream(request);
      },
    };
  }

  it("accepts a prompt with the default behavior queue, names it, and fires session.state before and after the turn", async () => {
    const h = verbHarness({ provider: new MockProvider([textTurn("done")]) });
    const id = await createSession(h);
    const reader = await h.stream();
    const accepted = await post(h, `/sessions/${id}/prompt`, { text: "go" });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      sessionId: id,
      accepted: true,
      queued: false,
      behavior: "queue",
    });
    expect((await reader.next()).event).toBe("turn.started");
    const accepting = await stateAfter(reader);
    expect(accepting).toMatchObject({ thinking: false, title: "session s1", redoable: false });
    await collect(reader, (event) => event === "turn.completed");
    expect(await stateAfter(reader)).toMatchObject({ leafId: "m1", undoable: true });
    await reader.close();
    expect((await post(h, `/sessions/${id}/prompt`, { text: "x", behavior: "later" })).status).toBe(
      400,
    );
    const doc = (await (await h.server.fetch(new Request(`${origin}/doc`))).json()) as {
      paths: Record<string, { post: { summary: string } }>;
    };
    expect(doc.paths["/sessions/{id}/prompt"]?.post.summary).toContain("defaults to `queue`");
  });

  it("steer interrupts the running turn and runs before a queued prompt", async () => {
    const h = verbHarness({
      provider: hangingThenScripted([textTurn("steered"), textTurn("queued answer")]),
    });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "first" });
    expect(await (await post(h, `/sessions/${id}/prompt`, { text: "later" })).json()).toMatchObject(
      { queued: true, behavior: "queue" },
    );
    expect(
      await (await post(h, `/sessions/${id}/prompt`, { text: "now", behavior: "steer" })).json(),
    ).toMatchObject({ queued: true, behavior: "steer" });
    const frames: SseFrame[] = [];
    while (frames.filter((frame) => frame.event === "turn.completed").length < 2) {
      frames.push(await reader.next());
    }
    await reader.close();
    const starts = frames
      .filter((frame) => frame.event === "turn.started")
      .map((frame) => payloadOf(frame).userText);
    expect(starts).toEqual(["first", "now", "later"]);
    expect(frames.map((frame) => frame.event)).toContain("turn.interrupted");
  });

  it("switches the model, answers an unknown reference with its failure code, and refuses mid-turn", async () => {
    const h = verbHarness({
      provider: new MockProvider([textTurn("hi")], "m1"),
      models: { "mock/m2": new MockProvider([textTurn("from m2")], "m2") },
    });
    const id = await createSession(h);
    const reader = await h.stream();
    const switched = await post(h, `/sessions/${id}/model`, { reference: "mock/m2" });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({
      model: { provider: "mock", model: "m2" },
      notice: "model → mock/m2",
    });
    expect(await stateAfter(reader)).toMatchObject({ model: "mock/m2" });
    await reader.close();
    const listed = (await (await h.call("/sessions")).json()) as {
      sessions: Array<{ model?: string }>;
    };
    expect(listed.sessions[0]?.model).toBe("mock/m2");

    const unknown = await post(h, `/sessions/${id}/model`, { reference: "nope" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({
      code: "unknown-model",
      failure: { code: "unknown-model", reference: "nope", known: ["mock/m2"] },
    });
    expect((await post(h, `/sessions/${id}/model`, {})).status).toBe(400);
    expect((await post(h, "/sessions/nope/model", { reference: "mock/m2" })).status).toBe(404);

    const busy = verbHarness({
      provider: hangingProvider(),
      models: { "mock/m2": new MockProvider([]) },
    });
    const busyId = await createSession(busy);
    const busyReader = await busy.stream();
    await post(busy, `/sessions/${busyId}/prompt`, { text: "wait" });
    await collect(busyReader, (event) => event === "turn.started");
    const refused = await post(busy, `/sessions/${busyId}/model`, { reference: "mock/m2" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "a turn is running" });
    await busyReader.close();
    await busy.server.close();
  });

  it("toggles thinking and sets effort, with null returning to the provider default", async () => {
    const h = verbHarness();
    const id = await createSession(h);
    const reader = await h.stream();
    expect(await (await post(h, `/sessions/${id}/thinking`, { on: true })).json()).toEqual({
      thinking: true,
    });
    expect(await stateAfter(reader)).toMatchObject({ thinking: true });
    expect((await post(h, `/sessions/${id}/thinking`, { on: "yes" })).status).toBe(400);
    expect((await post(h, "/sessions/nope/thinking", { on: true })).status).toBe(404);

    expect(await (await post(h, `/sessions/${id}/effort`, { level: "high" })).json()).toEqual({
      effort: "high",
    });
    expect(await stateAfter(reader)).toMatchObject({ effort: "high", thinking: true });
    expect(await (await post(h, `/sessions/${id}/effort`, { level: null })).json()).toEqual({
      effort: null,
    });
    const reset = await stateAfter(reader);
    expect(reset.thinking).toBe(true);
    expect(reset.effort).toBeUndefined();
    expect((await post(h, `/sessions/${id}/effort`, { level: "huge" })).status).toBe(400);
    expect((await post(h, `/sessions/${id}/effort`, {})).status).toBe(400);
    await reader.close();
  });

  it("compacts, answering the nothing-to-compact notice on the memory host, and refuses mid-turn", async () => {
    const h = verbHarness();
    const id = await createSession(h);
    const reader = await h.stream();
    const compacted = await post(h, `/sessions/${id}/compact`, { focus: "keep the goal" });
    expect(compacted.status).toBe(200);
    expect(await compacted.json()).toEqual({
      compacted: null,
      notices: ["nothing to compact yet · the recent turns are all that's here"],
    });
    expect((await reader.next()).event).toBe("session.state");
    expect((await post(h, `/sessions/${id}/compact`, { focus: 3 })).status).toBe(400);
    expect((await post(h, "/sessions/nope/compact")).status).toBe(404);
    await reader.close();

    const busy = verbHarness({ provider: hangingProvider() });
    const busyId = await createSession(busy);
    const busyReader = await busy.stream();
    await post(busy, `/sessions/${busyId}/prompt`, { text: "wait" });
    await collect(busyReader, (event) => event === "turn.started");
    expect((await post(busy, `/sessions/${busyId}/compact`)).status).toBe(409);
    expect((await post(busy, `/sessions/${busyId}/undo`)).status).toBe(409);
    await busyReader.close();
    await busy.server.close();
  });

  it("undoes the last prompt, hands its text back, and redo restores the transcript", async () => {
    const h = verbHarness({ provider: new MockProvider([textTurn("one"), textTurn("two")]) });
    const id = await createSession(h);
    const reader = await h.stream();
    for (const text of ["first", "second"]) {
      await post(h, `/sessions/${id}/prompt`, { text });
      await collect(reader, (event) => event === "turn.completed");
      await stateAfter(reader);
    }
    expect(await messagesOf(h, id)).toHaveLength(4);

    const undone = await post(h, `/sessions/${id}/undo`);
    expect(undone.status).toBe(200);
    expect(await undone.json()).toEqual({
      prompt: { entryId: "m2", text: "second" },
      filesNote: "files untouched",
      undoable: true,
      redoable: true,
    });
    expect(await stateAfter(reader)).toMatchObject({ leafId: "m1", redoable: true });
    expect(await messagesOf(h, id)).toHaveLength(2);

    const redone = await post(h, `/sessions/${id}/redo`);
    expect(await redone.json()).toEqual({ restored: true, undoable: true, redoable: false });
    expect(await messagesOf(h, id)).toHaveLength(4);
    const nothingToRedo = await post(h, `/sessions/${id}/redo`);
    expect(nothingToRedo.status).toBe(404);
    expect(await nothingToRedo.json()).toEqual({ error: "nothing to redo" });

    await post(h, `/sessions/${id}/undo`);
    expect(await (await post(h, `/sessions/${id}/undo`)).json()).toMatchObject({
      prompt: { entryId: "m0", text: "first" },
      undoable: false,
      redoable: true,
    });
    expect(await messagesOf(h, id)).toHaveLength(0);
    await post(h, `/sessions/${id}/redo`);
    expect(await messagesOf(h, id)).toHaveLength(2);
    await post(h, `/sessions/${id}/undo`);
    expect(await messagesOf(h, id)).toHaveLength(0);
    const nothingToUndo = await post(h, `/sessions/${id}/undo`);
    expect(nothingToUndo.status).toBe(404);
    expect(await nothingToUndo.json()).toEqual({ error: "nothing to undo" });
    expect((await post(h, "/sessions/nope/undo")).status).toBe(404);
    await reader.close();
  });

  it("reads the context gauge inputs and the cost rollup with its honesty basis", async () => {
    const h = verbHarness({ provider: new MockProvider([textTurn("hi")], "m1") });
    const id = await createSession(h);
    const context = await h.call(`/sessions/${id}/context`);
    expect(context.status).toBe(200);
    expect(await context.json()).toEqual({
      used: 0,
      window: 200_000,
      flushAt: 200_000 - 24_576,
      compactAt: 200_000 - 16_384,
      declared: false,
      fullness: 0,
      flushDue: false,
      compactionDue: false,
      basis: "estimated",
    });
    const cost = await h.call(`/sessions/${id}/cost`);
    expect(cost.status).toBe(200);
    expect(await cost.json()).toEqual({
      rollup: { nanos: 0, pricedTurns: 0, meteredTurns: 0, unpricedTurns: 0 },
      usage: { inputTokens: 0, outputTokens: 0 },
      modelId: "m1",
      basis: "no pricing for m1",
      models: [
        {
          reference: "mock/m1",
          turns: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          rollup: { nanos: 0, pricedTurns: 0, meteredTurns: 0, unpricedTurns: 0 },
        },
      ],
    });
    expect((await h.call("/sessions/nope/context")).status).toBe(404);
    expect((await h.call("/sessions/nope/cost")).status).toBe(404);
  });

  it("exports the transcript as html, refuses a file target it cannot confine, and a bad scope", async () => {
    const h = verbHarness({ provider: new MockProvider([textTurn("hello <there>")]) });
    const id = await createSession(h);
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "hi" });
    await collect(reader, (event) => event === "turn.completed");
    await reader.close();
    const page = await post(h, `/sessions/${id}/export`, {});
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await page.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("hello &lt;there>");
    expect((await post(h, `/sessions/${id}/export`, { out: "x.html" })).status).toBe(403);
    expect((await post(h, `/sessions/${id}/export`, { scope: "sideways" })).status).toBe(400);
    expect((await post(h, "/sessions/nope/export", {})).status).toBe(404);
  });

  it("renames a session and the title shows in the state and the summaries", async () => {
    const h = verbHarness();
    const id = await createSession(h);
    const reader = await h.stream();
    expect(
      await (await post(h, `/sessions/${id}/rename`, { title: "Deploy notes" })).json(),
    ).toEqual({ title: "Deploy notes" });
    expect(await stateAfter(reader)).toMatchObject({ title: "Deploy notes" });
    await reader.close();
    const listed = (await (await h.call("/sessions")).json()) as {
      sessions: Array<{ title: string }>;
    };
    expect(listed.sessions[0]?.title).toBe("Deploy notes");
    expect((await post(h, `/sessions/${id}/rename`, { title: " " })).status).toBe(400);
    expect((await post(h, "/sessions/nope/rename", { title: "x" })).status).toBe(404);
  });

  it("switches the process preset: tightening freely, loosening only when confirmed, every live session hearing gate.preset", async () => {
    let active: ActivePreset = "standard";
    const presets: PresetHost = {
      active: () => active,
      apply: async (name) => {
        active = name;
      },
    };
    const h = verbHarness({ presets });
    const id = await createSession(h);
    const reader = await h.stream();
    const tightened = await post(h, "/preset", { name: "careful" });
    expect(tightened.status).toBe(200);
    expect(await tightened.json()).toEqual({ from: "standard", to: "careful" });
    const heard = await reader.next();
    expect(heard.event).toBe("gate.preset");
    expect(JSON.parse(heard.data)).toMatchObject({
      sessionId: id,
      payload: { from: "standard", to: "careful" },
    });
    const loosened = await post(h, "/preset", { name: "open" });
    expect(loosened.status).toBe(409);
    expect(await loosened.json()).toEqual({ error: "loosening needs confirmed: true" });
    expect(active).toBe("careful");
    expect(await (await post(h, "/preset", { name: "open", confirmed: true })).json()).toEqual({
      from: "careful",
      to: "open",
    });
    expect(await (await post(h, "/preset", { name: "open" })).json()).toEqual({
      from: "open",
      to: "open",
    });
    expect((await post(h, "/preset", { name: "wild" })).status).toBe(400);
    expect((await post(h, "/preset", { name: "open", confirmed: false })).status).toBe(400);
    await reader.close();
    const bare = verbHarness();
    expect((await post(bare, "/preset", { name: "careful" })).status).toBe(501);
  });

  it("filters /events?session= to that session plus process-level envelopes, on replay and live", async () => {
    const h = verbHarness({ provider: new MockProvider([textTurn("a"), textTurn("b")]) });
    const first = await createSession(h);
    const second = await createSession(h);
    await post(h, `/sessions/${first}/rename`, { title: "first" });
    h.log.record("", "memory.inbox", { count: 1 });
    await post(h, `/sessions/${second}/rename`, { title: "second" });
    const replayed = sseReader(
      await h.call(`/events?session=${second}&x=1`, { headers: { "last-event-id": "0" } }),
    );
    const inbox = await replayed.next();
    expect(JSON.parse(inbox.data)).toMatchObject({ sessionId: "", type: "memory.inbox" });
    const renamed = await replayed.next();
    expect(JSON.parse(renamed.data)).toMatchObject({ sessionId: second, type: "session.state" });

    await post(h, `/sessions/${first}/prompt`, { text: "one" });
    await post(h, `/sessions/${second}/prompt`, { text: "two" });
    const live = await collect(replayed, (event) => event === "turn.completed");
    for (const frame of live) expect(JSON.parse(frame.data).sessionId).toBe(second);
    await replayed.close();

    const everything = sseReader(await h.call("/events", { headers: { "last-event-id": "0" } }));
    const ids = new Set<string>();
    for (let seen = 0; seen < 3; seen += 1)
      ids.add(JSON.parse((await everything.next()).data).sessionId);
    expect(ids).toEqual(new Set([first, "", second]));
    await everything.close();
  });

  it("speaks every verb through the typed client", async () => {
    const h = verbHarness({
      provider: new MockProvider([textTurn("hi")], "m1"),
      models: { "mock/m2": new MockProvider([], "m2") },
      presets: { active: () => "standard", apply: async () => {} },
    });
    const client = keyworkClient(
      { url: origin, token },
      { fetch: (input, init) => h.server.fetch(new Request(input, init)) },
    );
    const { id } = await client.createSession();
    const stops = new AbortController();
    const seen: string[] = [];
    let opened = (): void => undefined;
    const open = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const listening = (async () => {
      for await (const envelope of client.events({
        session: id,
        signal: stops.signal,
        onOpen: () => opened(),
      })) {
        seen.push(envelope.type);
        if (envelope.type === "turn.completed") break;
      }
    })();
    await open;
    expect(await client.prompt(id, "hello", "queue")).toBe("accepted");
    await listening;
    stops.abort();
    expect(seen[0]).toBe("turn.started");
    expect(seen).toContain("session.state");
    expect(await client.setThinking(id, true)).toEqual({ thinking: true });
    expect(await client.setEffort(id, "low")).toEqual({ effort: "low" });
    expect(await client.setEffort(id, null)).toEqual({ effort: null });
    expect(await client.compact(id, "focus")).toMatchObject({ compacted: null });
    expect(await client.setModel(id, "mock/m2")).toEqual({
      model: { provider: "mock", model: "m2" },
      notice: "model → mock/m2",
    });
    expect(await client.setModel(id, "nope")).toMatchObject({ failure: { code: "unknown-model" } });
    expect(await client.undo(id)).toMatchObject({ prompt: { text: "hello" } });
    expect(await client.redo(id)).toMatchObject({ restored: true });
    expect(await client.redo(id)).toBe("nothing");
    expect(await client.undo("nope")).toBe("missing");
    expect((await client.context(id))?.basis).toBe("estimated");
    expect((await client.cost(id))?.models[0]?.reference).toBe("mock/m2");
    const exported = await client.exportSession(id);
    expect(exported !== undefined && "html" in exported && exported.html).toContain(
      "<!doctype html>",
    );
    expect(await client.rename(id, "typed")).toEqual({ title: "typed" });
    expect(await client.applyPreset("careful")).toEqual({ from: "standard", to: "careful" });
    await expect(client.applyPreset("open")).rejects.toMatchObject({ status: 409 });
    expect(await client.setThinking("nope", true)).toBeUndefined();
    await h.server.close();
  });
});

describe("session lifecycle (119) over the memory host", () => {
  const remove = (h: Harness, id: string) => h.call(`/sessions/${id}`, { method: "DELETE" });
  const payloadOf = (frame: SseFrame) => JSON.parse(frame.data) as BusEnvelope;

  it("answers 503 on every lifecycle route when the host serves no trash", async () => {
    const log = new EventLog();
    const { lifecycle, ...host } = memorySessionHost({ log, provider: new MockProvider([]) });
    expect(lifecycle).toBeDefined();
    const server = createKeyworkServer({ token, host, log, version: "0.0.1-test" });
    const call = (path: string, method: string) =>
      server.fetch(
        new Request(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}` } }),
      );

    const statuses = await Promise.all(
      [
        ["/sessions/s1", "DELETE"],
        ["/trash", "GET"],
        ["/trash/s1/restore", "POST"],
        ["/trash/s1", "DELETE"],
        ["/trash", "DELETE"],
      ].map(async ([path, method]) => (await call(path ?? "", method ?? "")).status),
    );

    expect(statuses).toEqual([503, 503, 503, 503, 503]);
    await server.close();
  });

  it("moves a session to the trash and back, announcing both at process level", async () => {
    const h = harness();
    const id = await createSession(h);
    const reader = await h.stream();

    const removed = await remove(h, id);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ id, title: `session ${id}` });
    const listed = (await (await h.call("/sessions")).json()) as { sessions: unknown[] };
    expect(listed.sessions).toEqual([]);
    expect((await h.call(`/sessions/${id}`)).status).toBe(404);
    const trashed = (await (await h.call("/trash")).json()) as { sessions: Array<{ id: string }> };
    expect(trashed.sessions.map((session) => session.id)).toEqual([id]);
    const removedEvent = payloadOf(await reader.next());
    expect(removedEvent).toMatchObject({
      sessionId: "",
      type: "session.removed",
      payload: { sessionId: id },
    });

    const restored = await h.call(`/trash/${id}/restore`, { method: "POST" });
    expect(restored.status).toBe(201);
    expect(await restored.json()).toMatchObject({ id });
    expect((await h.call(`/sessions/${id}`)).status).toBe(200);
    expect(((await (await h.call("/trash")).json()) as { sessions: unknown[] }).sessions).toEqual(
      [],
    );
    expect(payloadOf(await reader.next())).toMatchObject({
      sessionId: "",
      type: "session.restored",
      payload: { sessionId: id },
    });
    await reader.close();
    await h.server.close();
  });

  it("refuses an unknown session, a running turn, and a miss in the trash", async () => {
    const h = harness({ provider: hangingProvider() });
    const id = await createSession(h);
    expect((await remove(h, "nope")).status).toBe(404);
    expect((await h.call("/trash/nope/restore", { method: "POST" })).status).toBe(404);
    expect((await h.call("/trash/nope", { method: "DELETE" })).status).toBe(404);

    await h.call(`/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hang" }),
    });
    const busy = await remove(h, id);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "a turn is running" });
    expect(
      ((await (await h.call("/sessions")).json()) as { sessions: unknown[] }).sessions,
    ).toHaveLength(1);
    await h.server.close();
  });

  it("discards one trashed session and purges the rest, through the typed client", async () => {
    const h = harness();
    const client = keyworkClient(
      { url: origin, token },
      { fetch: (input, init) => h.server.fetch(new Request(input, init)) },
    );
    const first = await createSession(h);
    const second = await createSession(h);
    const third = await createSession(h);

    expect(await client.removeSession(first)).toMatchObject({ id: first });
    expect(await client.removeSession(second)).toMatchObject({ id: second });
    expect(await client.removeSession(third)).toMatchObject({ id: third });
    expect(await client.removeSession("nope")).toBe("missing");
    expect((await client.trash()).map((session) => session.id)).toEqual([first, second, third]);
    expect(await client.restoreSession(first)).toMatchObject({ id: first });
    expect(await client.restoreSession(first)).toBeUndefined();
    expect(await client.discardTrashedSession(second)).toBe(true);
    expect(await client.discardTrashedSession(second)).toBe(false);
    expect(await client.purgeTrash()).toEqual({ purged: 1 });
    expect(await client.trash()).toEqual([]);
    expect((await client.sessions()).map((session) => session.id)).toEqual([first]);
    await h.server.close();
  });
});

describe("tree and diff (118 K2) over the memory host", () => {
  interface World {
    before: Record<string, string>;
    working: Record<string, string>;
  }

  function changesOver(world: World): ChangesSource {
    return {
      label: "session start",
      changes: async () =>
        [...new Set([...Object.keys(world.before), ...Object.keys(world.working)])]
          .filter((path) => world.before[path] !== world.working[path])
          .sort()
          .map((path) => ({ path, added: 1, deleted: 0, turn: 1 })),
      before: async (path) => world.before[path],
      after: async (path) => world.working[path],
    };
  }

  function writeTool(world: World): Tool {
    return {
      name: "write",
      description: "writes",
      parameters: { type: "object" },
      execute: async (args) => {
        const { path, content } = args as { path: string; content: string };
        world.working[path] = content;
        return "written";
      },
    };
  }

  function treeHarness(
    options: { provider?: Provider; tools?: readonly Tool[]; changes?: ChangesSource } = {},
  ) {
    const log = new EventLog({ now: () => new Date("2026-10-11T09:00:00.000Z") });
    const host = memorySessionHost({
      log,
      provider: options.provider ?? new MockProvider([]),
      ...(options.tools !== undefined && { tools: options.tools }),
      ...(options.changes !== undefined && { changes: options.changes }),
    });
    const server = createKeyworkServer({ token, host, log, version: "0.0.1-test" });
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

  const post = (h: Harness, path: string, body?: unknown) =>
    h.call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const envelopeIn = (frame: SseFrame) => JSON.parse(frame.data) as BusEnvelope;
  const turnOf = async (h: Harness, id: string, text: string) => {
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text });
    await collect(reader, (event) => event === "turn.completed");
    await reader.close();
  };
  const body = async <Shape>(response: Response): Promise<Shape> =>
    (await response.json()) as Shape;

  it("lists the entry log with labels, leaf and active path, labels entries, and forks a session whose detail names its parent, announcing session.tree", async () => {
    const h = treeHarness({ provider: new MockProvider([textTurn("hello back")]) });
    const id = await createSession(h);
    await turnOf(h, id, "hello");
    const reader = await h.stream();

    const entries = await body<{
      sessionId: string;
      name: string;
      leafId: string;
      entries: Array<{ id: string; parentId: string | null; type: string }>;
      labels: Record<string, string>;
      activePath: string[];
    }>(await h.call(`/sessions/${id}/entries`));
    expect(entries).toMatchObject({ sessionId: id, name: "session s1", leafId: "m1" });
    expect(entries.entries.map(({ id, parentId, type }) => ({ id, parentId, type }))).toEqual([
      { id: "m0", parentId: null, type: "message" },
      { id: "m1", parentId: "m0", type: "message" },
    ]);
    expect(entries).toMatchObject({ labels: {}, activePath: ["m0", "m1"] });

    const labelled = await post(h, `/sessions/${id}/label`, { entryId: "m0", label: "start" });
    expect(await labelled.json()).toEqual({ entryId: "m0", label: "start" });
    expect(
      (await body<{ labels: Record<string, string> }>(await h.call(`/sessions/${id}/entries`)))
        .labels,
    ).toEqual({ m0: "start" });
    expect(
      await (await post(h, `/sessions/${id}/label`, { entryId: "m0", label: null })).json(),
    ).toEqual({ entryId: "m0", label: null });

    const forked = await post(h, `/sessions/${id}/fork`, { entryId: "m0" });
    expect(forked.status).toBe(201);
    const { sessionId } = await body<{ sessionId: string }>(forked);
    expect(sessionId).not.toBe(id);
    const detail = await body<{ parentSession?: string; messages: Message[] }>(
      await h.call(`/sessions/${sessionId}`),
    );
    expect(detail.parentSession).toBe(id);
    expect(detail.messages).toHaveLength(1);
    expect(
      await body<{ messages: Message[] }>(await h.call(`/sessions/${id}`)).then((d) => d.messages),
    ).toHaveLength(2);

    const changes = [];
    while (changes.length < 3) {
      const frame = (await collect(reader, (event) => event === "session.tree")).at(-1) as SseFrame;
      changes.push(envelopeIn(frame));
    }
    expect(changes.every((envelope) => envelope.sessionId === id)).toBe(true);
    expect(changes.map((envelope) => envelope.payload)).toEqual([
      { reason: "label", entryId: "m0" },
      { reason: "label", entryId: "m0" },
      { reason: "fork", entryId: "m0", forkedTo: sessionId },
    ]);
    await reader.close();

    expect((await post(h, `/sessions/${id}/fork`, { entryId: "m9" })).status).toBe(404);
    expect(await (await post(h, `/sessions/${id}/fork`, { entryId: "m9" })).json()).toEqual({
      error: "no entry has that id",
    });
    expect((await post(h, `/sessions/${id}/label`, { entryId: "m9", label: "x" })).status).toBe(
      404,
    );
    expect((await post(h, "/sessions/nope/fork", { entryId: "m0" })).status).toBe(404);
    expect((await h.call("/sessions/nope/entries")).status).toBe(404);
    expect((await post(h, `/sessions/${id}/fork`, {})).status).toBe(400);
    expect((await post(h, `/sessions/${id}/label`, { entryId: "m0" })).status).toBe(400);
    expect((await post(h, `/sessions/${id}/label`, { entryId: "m0", label: "" })).status).toBe(400);
  });

  it("moves the leaf without forking, answers null for the root, refuses mid-turn, and announces session.tree then session.state", async () => {
    const h = treeHarness({
      provider: hangingThenScriptedK2([textTurn("one"), textTurn("two")]),
    });
    const id = await createSession(h);
    const opening = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "first" });
    await collect(opening, (event) => event === "turn.started");
    const busy = await post(h, `/sessions/${id}/leaf`, { entryId: "m0" });
    expect(busy.status).toBe(409);
    await post(h, `/sessions/${id}/abort`);
    await collect(opening, (event) => event === "turn.interrupted");
    await opening.close();
    await turnOf(h, id, "second");
    await turnOf(h, id, "third");
    expect((await body<{ leafId: string }>(await h.call(`/sessions/${id}/entries`))).leafId).toBe(
      "m5",
    );

    const reader = await h.stream();
    const moved = await post(h, `/sessions/${id}/leaf`, { entryId: "m3" });
    expect(await moved.json()).toEqual({ leafId: "m3" });
    expect(
      (await body<{ messages: Message[] }>(await h.call(`/sessions/${id}`))).messages,
    ).toHaveLength(4);
    const [state, tree] = (await collect(reader, (event) => event === "session.tree")).map(
      envelopeIn,
    );
    expect(state).toMatchObject({ type: "session.state", payload: { leafId: "m3" } });
    expect(tree).toMatchObject({ sessionId: id, type: "session.tree" });
    expect(tree?.payload).toEqual({ reason: "leaf", entryId: "m3" });
    await reader.close();

    expect(await (await post(h, `/sessions/${id}/leaf`, { entryId: null })).json()).toEqual({
      leafId: null,
    });
    expect((await body<{ messages: Message[] }>(await h.call(`/sessions/${id}`))).messages).toEqual(
      [],
    );
    expect((await post(h, `/sessions/${id}/leaf`, { entryId: "m9" })).status).toBe(404);
    expect((await post(h, `/sessions/${id}/leaf`, {})).status).toBe(400);
    expect((await post(h, "/sessions/nope/leaf", { entryId: null })).status).toBe(404);
  });

  it("answers no baseline when the host has none, and otherwise lists changes with their turn and fires changes.updated after a write tool", async () => {
    const bare = treeHarness();
    const bareId = await createSession(bare);
    const refused = await bare.call(`/sessions/${bareId}/changes`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "no baseline" });
    expect((await bare.call(`/sessions/${bareId}/changes/file?path=a`)).status).toBe(409);
    expect((await bare.call("/sessions/nope/changes")).status).toBe(404);

    const world: World = { before: {}, working: {} };
    const h = treeHarness({
      provider: new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "w1",
          name: "write",
          arguments: { path: "note.txt", content: "hello" },
        }),
        textTurn("wrote it"),
      ]),
      tools: [writeTool(world)],
      changes: changesOver(world),
    });
    const id = await createSession(h);
    expect(await (await h.call(`/sessions/${id}/changes`)).json()).toEqual({
      baseline: "session start",
      files: [],
    });
    const reader = await h.stream();
    await post(h, `/sessions/${id}/prompt`, { text: "write a note" });
    const updated = (await collect(reader, (event) => event === "changes.updated")).at(
      -1,
    ) as SseFrame;
    expect(envelopeIn(updated)).toMatchObject({
      sessionId: id,
      payload: { paths: ["note.txt"], turn: 1 },
    });
    await reader.close();
    expect(await (await h.call(`/sessions/${id}/changes`)).json()).toEqual({
      baseline: "session start",
      files: [{ path: "note.txt", added: 1, deleted: 0, turn: 1 }],
    });
  });

  it("answers both sides of a changed file with the new, deleted, binary and unreadable notes, capping each side at 1 MiB on a character boundary", async () => {
    const cap = fileChangeCapBytes;
    const world: World = {
      before: {
        "gone.txt": "was here",
        "same.txt": "same",
        "blob.bin": "a\0b",
        "exact.txt": "a".repeat(cap),
        "euro.txt": "€".repeat(Math.ceil((cap + 1) / 3)),
      },
      working: {
        "new.txt": "fresh",
        "same.txt": "same",
        "blob.bin": "a\0c",
        "exact.txt": "a".repeat(cap),
        "over.txt": "b".repeat(cap + 1),
      },
    };
    const h = treeHarness({ changes: changesOver(world) });
    const id = await createSession(h);
    const file = async (path: string) =>
      body<{
        path: string;
        before: string | null;
        after: string | null;
        note?: string;
        truncated: boolean;
      }>(await h.call(`/sessions/${id}/changes/file?path=${encodeURIComponent(path)}`));

    expect(await file("new.txt")).toEqual({
      path: "new.txt",
      before: null,
      after: "fresh",
      note: "new",
      truncated: false,
    });
    expect(await file("gone.txt")).toEqual({
      path: "gone.txt",
      before: "was here",
      after: null,
      note: "deleted",
      truncated: false,
    });
    expect(await file("same.txt")).toEqual({
      path: "same.txt",
      before: "same",
      after: "same",
      truncated: false,
    });
    expect(await file("blob.bin")).toEqual({
      path: "blob.bin",
      before: null,
      after: null,
      note: "binary",
      truncated: false,
    });
    expect(await file("ghost.txt")).toEqual({
      path: "ghost.txt",
      before: null,
      after: null,
      note: "unreadable",
      truncated: false,
    });
    const exact = await file("exact.txt");
    expect(exact.truncated).toBe(false);
    expect(exact.before?.length).toBe(cap);
    const over = await file("over.txt");
    expect(over).toMatchObject({ before: null, note: "new", truncated: true });
    expect(over.after?.length).toBe(cap);
    const euro = await file("euro.txt");
    expect(euro).toMatchObject({ after: null, note: "deleted", truncated: true });
    expect(euro.before?.length).toBe(Math.floor(cap / 3));
    expect(euro.before?.includes("�")).toBe(false);
    expect((await h.call(`/sessions/${id}/changes/file`)).status).toBe(400);
    expect((await h.call("/sessions/nope/changes/file?path=new.txt")).status).toBe(404);
  });

  it("drives the tree and the diff through the typed client", async () => {
    const world: World = { before: {}, working: { "new.txt": "fresh" } };
    const h = treeHarness({
      provider: new MockProvider([textTurn("hi")]),
      changes: changesOver(world),
    });
    const client = keyworkClient(
      { url: origin, token },
      { fetch: (input, init) => h.server.fetch(new Request(input, init)) },
    );
    const { id } = await client.createSession();
    await turnOf(h, id, "hello");
    expect((await client.entries(id))?.activePath).toEqual(["m0", "m1"]);
    expect(await client.labelEntry(id, "m1", "answer")).toEqual({ entryId: "m1", label: "answer" });
    const forked = await client.fork(id, "m0");
    expect((await client.session(forked?.sessionId ?? ""))?.parentSession).toBe(id);
    expect(await client.moveLeaf(id, "m0")).toEqual({ leafId: "m0" });
    expect((await client.changes(id))?.files).toEqual([
      { path: "new.txt", added: 1, deleted: 0, turn: 1 },
    ]);
    expect(await client.changedFile(id, "new.txt")).toMatchObject({ after: "fresh", note: "new" });
    expect(await client.entries("nope")).toBeUndefined();
    expect(await client.fork(id, "m9")).toBeUndefined();
    expect(await client.changes("nope")).toBeUndefined();

    const bare = treeHarness();
    const bareClient = keyworkClient(
      { url: origin, token },
      { fetch: (input, init) => bare.server.fetch(new Request(input, init)) },
    );
    const { id: bareId } = await bareClient.createSession();
    await expect(bareClient.changes(bareId)).rejects.toMatchObject({ status: 409 });
    await h.server.close();
    await bare.server.close();
  });

  function hangingThenScriptedK2(turns: TurnDelta[][]): Provider {
    const scripted = new MockProvider(turns);
    let first = true;
    const hanging = hangingProvider();
    return {
      name: "mock",
      stream: (request) => {
        if (!first) return scripted.stream(request);
        first = false;
        return hanging.stream(request);
      },
    };
  }
});
