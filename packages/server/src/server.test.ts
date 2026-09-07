import {
  type EngineEvents,
  EventBus,
  type Message,
  MockProvider,
  type Provider,
  type ProviderRequest,
  type Tool,
  type TurnDelta,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { type BusEnvelope, type EngineEventType, EventLog, engineEventTypes } from "./events.ts";
import { listen } from "./listen.ts";
import { routes } from "./openapi.ts";
import { createKeyworkServer, type KeyworkServer } from "./server.ts";
import { memorySessionHost, type SseReader, sseReader } from "./testing.ts";

const token = "test-token-1234567890";
const origin = "http://keywork.test";

interface Harness {
  server: KeyworkServer;
  log: EventLog;
  call(path: string, init?: RequestInit): Promise<Response>;
  stream(lastEventId?: number): Promise<SseReader>;
}

function harness(
  options: { provider?: Provider; tools?: readonly Tool[]; capacity?: number } = {},
) {
  const log = new EventLog({
    ...(options.capacity !== undefined && { capacity: options.capacity }),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
  });
  const host = memorySessionHost({
    log,
    provider: options.provider ?? new MockProvider([]),
    ...(options.tools !== undefined && { tools: options.tools }),
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
  "gate.permission": {
    decision: { tool: "bash", callId: "c2", verdict: "denied", gate: "headless" },
  },
  "gate.preset": { from: "standard", to: "open" },
  "session.mode": { mode: "plan" },
  "context.injected": { injection: { source: "memory-recall", id: "n1", scope: "workspace" } },
  "diagnostics.published": { path: "src/a.ts", count: 2 },
  "shell.reset": { replay: true },
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
        expect(JSON.parse(frame.data).payload).toEqual(samplePayloads[envelope.type]);
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
    expect(await accepted.json()).toEqual({ sessionId: id, accepted: true });

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
