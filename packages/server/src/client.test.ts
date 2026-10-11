import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MockProvider,
  type Provider,
  type ProviderRequest,
  type TurnDelta,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Fetch,
  type KeyworkClient,
  keyworkClient,
  reconnectDelayMs,
  resolveServerTicket,
  ServerRefusal,
} from "./client.ts";
import { type BusEnvelope, EventLog } from "./events.ts";
import { listen } from "./listen.ts";
import { createKeyworkServer, type KeyworkServer } from "./server.ts";
import { memorySessionHost } from "./testing.ts";
import { writeServerTicket } from "./token.ts";

const token = "client-test-token-123";
const url = "http://keywork.test";

interface Harness {
  server: KeyworkServer;
  log: EventLog;
  fetch: Fetch;
  client: KeyworkClient;
  delays: number[];
}

function harness(provider: Provider = new MockProvider([])): Harness {
  const log = new EventLog({ now: () => new Date("2026-09-07T09:00:00.000Z") });
  const host = memorySessionHost({ log, provider });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const call: Fetch = (input, init) => server.fetch(new Request(input, init));
  const delays: number[] = [];
  const client = keyworkClient(
    { url, token },
    {
      fetch: call,
      delay: async (ms) => {
        delays.push(ms);
      },
    },
  );
  return { server, log, fetch: call, client, delays };
}

async function take(events: AsyncIterable<BusEnvelope>, count: number): Promise<BusEnvelope[]> {
  const taken: BusEnvelope[] = [];
  for await (const envelope of events) {
    taken.push(envelope);
    if (taken.length === count) break;
  }
  return taken;
}

describe("resolveServerTicket", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "keywork-client-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("reads the ticket file and lets --url or --token override one half", () => {
    const file = join(dir, "server.json");
    writeServerTicket(file, { url: "http://127.0.0.1:4770", token: "stored" });
    expect(resolveServerTicket({ file })).toEqual({
      url: "http://127.0.0.1:4770",
      token: "stored",
    });
    expect(resolveServerTicket({ file, url: "http://127.0.0.1:9000" })).toEqual({
      url: "http://127.0.0.1:9000",
      token: "stored",
    });
    expect(resolveServerTicket({ file, token: "flag" })).toEqual({
      url: "http://127.0.0.1:4770",
      token: "flag",
    });
  });

  it("needs no file when both flags are given, and yields nothing when the file is missing", () => {
    const missing = join(dir, "absent.json");
    expect(resolveServerTicket({ file: missing, url: "http://x", token: "t" })).toEqual({
      url: "http://x",
      token: "t",
    });
    expect(resolveServerTicket({ file: missing })).toBeUndefined();
    expect(resolveServerTicket({ file: missing, url: "http://x" })).toBeUndefined();
  });
});

describe("keyworkClient routes", () => {
  it("sends the bearer token on every route", async () => {
    const seen: Array<{ method: string; path: string; auth: string | null }> = [];
    const h = harness();
    const recording = keyworkClient(
      { url: `${url}/`, token },
      {
        fetch: (input, init) => {
          const request = new Request(input, init);
          seen.push({
            method: request.method,
            path: new URL(request.url).pathname,
            auth: request.headers.get("authorization"),
          });
          return h.fetch(input, init);
        },
      },
    );
    const created = await recording.createSession();
    await recording.sessions();
    await recording.session(created.id);
    await recording.prompt(created.id, "hello");
    await recording.abort(created.id);
    const stops = new AbortController();
    const first = take(recording.events({ since: 0, signal: stops.signal }), 1);
    await first;
    stops.abort();
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /sessions",
      "GET /sessions",
      `GET /sessions/${created.id}`,
      `POST /sessions/${created.id}/prompt`,
      `POST /sessions/${created.id}/abort`,
      "GET /events",
    ]);
    expect(seen.every((call) => call.auth === `Bearer ${token}`)).toBe(true);
  });

  it("lists, creates, reads, prompts and aborts, with missing ids as outcomes", async () => {
    const h = harness();
    expect(await h.client.sessions()).toEqual([]);
    const created = await h.client.createSession();
    expect(created.id).toBe("s1");
    expect((await h.client.sessions()).map((session) => session.id)).toEqual(["s1"]);
    const detail = await h.client.session("s1");
    expect(detail?.live).toBe(true);
    expect(detail?.messages).toEqual([]);
    expect(await h.client.session("nope")).toBeUndefined();
    expect(await h.client.prompt("nope", "hi")).toBe("missing");
    expect(await h.client.abort("nope")).toBe("missing");
    expect(await h.client.abort("s1")).toBe("idle");
    expect(await h.client.prompt("s1", "hi")).toBe("started");
  });

  it("drives every session verb and the preset switch, with refusals as outcomes", async () => {
    const h = harness(new MockProvider([textTurn("ok")]));
    const { id } = await h.client.createSession();
    expect(await h.client.setModel(id, "anything")).toMatchObject({
      ok: false,
      failure: { code: "unconfigured" },
    });
    expect(await h.client.setModel("nope", "x")).toBe("missing");
    expect(await h.client.setThinking(id, true)).toEqual({ thinking: true });
    expect(await h.client.setEffort(id, "low")).toEqual({ effort: "low" });
    expect(await h.client.setEffort(id, null)).toEqual({ effort: null });
    expect(await h.client.compact(id, "focus")).toMatchObject({ compacted: null });
    expect(await h.client.undo(id)).toBe("nothing");
    expect(await h.client.redo(id)).toBe("nothing");
    expect(await h.client.undo("nope")).toBe("missing");
    expect(await h.client.prompt(id, "hello")).toBe("started");
    const stops = new AbortController();
    for await (const envelope of h.client.events({ since: 0, session: id, signal: stops.signal })) {
      if (envelope.type === "turn.completed") break;
    }
    stops.abort();
    expect(await h.client.undo(id)).toMatchObject({ prompt: { text: "hello" }, redoable: true });
    expect(await h.client.undo(id)).toBe("staged");
    expect(await h.client.redo(id)).toMatchObject({ restored: true });
    expect(await h.client.context(id)).toMatchObject({ basis: "estimated" });
    expect(await h.client.cost(id)).toMatchObject({ models: expect.any(Array) });
    expect(await h.client.exportSession(id)).toMatchObject({
      html: expect.stringContaining("hello"),
    });
    expect(await h.client.exportSession(id, { out: "x" })).toMatchObject({
      refused: expect.any(String),
    });
    expect(await h.client.rename(id, "Named")).toEqual({ title: "Named" });
    expect(await h.client.setPreset("open")).toBe("needs-confirmation");
    expect(await h.client.setPreset("open", true)).toEqual({ from: "standard", to: "open" });
    expect(await h.client.rename("nope", "x")).toBe("missing");
  });

  it("refuses a bad token with a ServerRefusal naming the status", async () => {
    const h = harness();
    const wrong = keyworkClient({ url, token: "not-it" }, { fetch: h.fetch });
    await expect(wrong.sessions()).rejects.toBeInstanceOf(ServerRefusal);
    await expect(wrong.sessions()).rejects.toMatchObject({ status: 401 });
    const stops = new AbortController();
    await expect(take(wrong.events({ signal: stops.signal }), 1)).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("keyworkClient events", () => {
  it("iterates envelopes, resuming from the ring with since", async () => {
    const h = harness();
    h.log.record("s1", "session.mode", { mode: "plan" });
    h.log.record("s1", "shell.reset", {});
    h.log.record("s2", "session.mode", { mode: "build" });
    const stops = new AbortController();
    const seen = await take(h.client.events({ since: 1, signal: stops.signal }), 2);
    stops.abort();
    expect(seen.map((envelope) => [envelope.id, envelope.sessionId, envelope.type])).toEqual([
      [2, "s1", "shell.reset"],
      [3, "s2", "session.mode"],
    ]);
    expect(h.delays).toEqual([]);
  });

  it("reconnects after the stream drops, resuming from the last id it saw", async () => {
    const h = harness();
    for (const mode of ["one", "two", "three", "four"]) {
      h.log.record("s1", "session.mode", { mode });
    }
    const resumeHeaders: Array<string | null> = [];
    let streams = 0;
    const dropping: Fetch = (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== "/events") return h.fetch(input, init);
      resumeHeaders.push(request.headers.get("last-event-id"));
      streams += 1;
      if (streams > 1) return h.fetch(input, init);
      const first = h.log.since(0).slice(0, 2);
      const body = first.map(
        (e) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
      );
      return Promise.resolve(
        new Response(body.join(""), { headers: { "content-type": "text/event-stream" } }),
      );
    };
    const delays: number[] = [];
    const client = keyworkClient(
      { url, token },
      {
        fetch: dropping,
        delay: async (ms) => {
          delays.push(ms);
        },
      },
    );
    const stops = new AbortController();
    const seen = await take(client.events({ since: 0, signal: stops.signal }), 4);
    stops.abort();
    expect(seen.map((envelope) => envelope.id)).toEqual([1, 2, 3, 4]);
    expect(resumeHeaders).toEqual(["0", "2"]);
    expect(delays).toEqual([reconnectDelayMs(0)]);
  });

  it("backs off geometrically to a ceiling", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelayMs)).toEqual([
      250, 500, 1000, 2000, 4000, 5000, 5000,
    ]);
  });

  it("stops without a reconnect once the signal aborts", async () => {
    const h = harness();
    const stops = new AbortController();
    const iteration = take(h.client.events({ signal: stops.signal }), 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    stops.abort();
    expect(await iteration).toEqual([]);
    expect(h.delays).toEqual([]);
  });
});

describe("over a real socket", () => {
  it("round-trips a prompt through listen() and reads the turn from /events", async () => {
    const log = new EventLog();
    const provider = new MockProvider([textTurn("served over tcp")]);
    const host = memorySessionHost({ log, provider });
    const bound = await listen({ token, host, log, version: "test", port: 0 });
    try {
      const client = keyworkClient({ url: bound.url, token });
      const created = await client.createSession();
      const stops = new AbortController();
      const events = client.events({ since: 0, signal: stops.signal });
      const collected: BusEnvelope[] = [];
      const finished = (async () => {
        for await (const envelope of events) {
          collected.push(envelope);
          if (envelope.type === "turn.completed") break;
        }
      })();
      expect(await client.prompt(created.id, "hello over tcp")).toBe("started");
      await finished;
      stops.abort();
      const types = collected.map((envelope) => envelope.type);
      expect(types[0]).toBe("turn.started");
      expect(types).toContain("turn.delta");
      expect(types.at(-1)).toBe("turn.completed");
      const detail = await client.session(created.id);
      expect(detail?.messages).toHaveLength(2);
      expect(await client.abort(created.id)).toBe("idle");
    } finally {
      await bound.close();
    }
  });

  it("aborts a hanging turn through the wire", async () => {
    const log = new EventLog();
    const host = memorySessionHost({ log, provider: hangingProvider() });
    const bound = await listen({ token, host, log, version: "test", port: 0 });
    try {
      const client = keyworkClient({ url: bound.url, token });
      const created = await client.createSession();
      const stops = new AbortController();
      const events = client.events({ since: 0, signal: stops.signal });
      const sawStart = new Promise<void>((resolve) => {
        void (async () => {
          for await (const envelope of events) {
            if (envelope.type === "turn.started") resolve();
            if (envelope.type === "turn.interrupted") break;
          }
        })();
      });
      await client.prompt(created.id, "wait");
      await sawStart;
      expect(await client.abort(created.id)).toBe("aborted");
      stops.abort();
    } finally {
      await bound.close();
    }
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

describe("spills through the client", () => {
  it("reads a spill by id and range, with an unknown id as undefined", async () => {
    const output = "z".repeat(70 * 1024);
    const log = new EventLog();
    const host = memorySessionHost({
      log,
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "flood", arguments: {} }),
        textTurn("done"),
      ]),
      tools: [
        {
          name: "flood",
          description: "floods",
          parameters: { type: "object" },
          execute: async () => output,
        },
      ],
    });
    const server = createKeyworkServer({ token, host, log, version: "test" });
    const client = keyworkClient(
      { url, token },
      { fetch: (input, init) => server.fetch(new Request(input, init)) },
    );
    const completed = new Promise<void>((resolve) => {
      log.subscribe((envelope) => {
        if (envelope.type === "turn.completed") resolve();
      });
    });
    const { id } = await client.createSession();
    await client.prompt(id, "flood");
    await completed;
    const parts = (await client.session(id))?.messages.flatMap((message) => message.parts) ?? [];
    const spill = parts.find((part) => part.type === "tool-result")?.spill;
    if (spill === undefined) throw new Error("the tool output did not spill");
    const slice = await client.spill(id, spill.id, { from: 10, to: 20 });
    expect(slice).toEqual({
      spillId: spill.id,
      bytes: output.length,
      from: 10,
      to: 20,
      text: "z".repeat(10),
      truncated: false,
      eof: false,
      encoding: "utf-8",
    });
    expect((await client.spill(id, spill.id))?.text).toBe(output);
    expect(await client.spill(id, "no-such-spill")).toBeUndefined();
    await server.close();
  });
});
