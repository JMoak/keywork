import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArcRegistry,
  formatReference,
  type InferenceBinding,
  isMemoryFlushPrompt,
  type Message,
  MockProvider,
  type ModelCapabilities,
  messageText,
  type Provider,
  type ProviderRequest,
  parseReference,
  type TurnDelta,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import {
  createKeyworkServer,
  EventLog,
  type SessionInference,
  type SessionSettlement,
  type SessionState,
} from "@keywork/server";
import { type SseFrame, type SseReader, sseReader } from "@keywork/server/testing";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { openWorkspaceMemory } from "./memory.ts";
import { type HostOptions, servedHost } from "./serve.ts";
import { findSession } from "./sessions/store.ts";

const tempDir = scratchDirs("keywork-parity-");
const token = "parity-token";
const tinyWindow: ModelCapabilities = { input: ["text"], toolCalls: true, contextWindow: 4000 };
const pastTheWindow = "x".repeat(15_000);

describe("serve parity: the after-turn settler", () => {
  it("flushes memory and compacts after a turn, announcing session.settled, once per turn", async () => {
    const provider = parityProvider(
      [textTurn("ok"), textTurn("## Goal\nthe serve summary"), textTurn("fine")],
      { capabilities: tinyWindow, flushReply: "- remembered under serve" },
    );
    const world = await servedWorld(provider);
    try {
      const id = await world.createSession();
      const reader = await world.events();
      await world.post(`/sessions/${id}/prompt`, { text: pastTheWindow });
      const settled = payloadOf<SessionSettlement>(
        await until(reader, (frame) => frame.event === "session.settled"),
      );
      expect(settled).toMatchObject({
        phase: "after-turn",
        flushed: 2,
        compacted: { type: "compaction", summary: expect.stringContaining("the serve summary") },
      });
      expect(settled.notices[0]).toMatch(/^compacted /);
      await until(reader, (frame) => frame.event === "session.state");
      const daily = await openWorkspaceMemory(world.cwd, true)?.store.readDaily();
      expect(daily?.map((entry) => entry.text)).toEqual(["- remembered under serve"]);
      const detail = await world.json<{ messages: Message[] }>(`/sessions/${id}`);
      expect(JSON.stringify(detail.messages[0])).toContain("the serve summary");

      await world.post(`/sessions/${id}/prompt`, { text: "short" });
      await until(reader, (frame) => frame.event === "turn.completed");
      await until(reader, (frame) => frame.event === "session.state");
      expect(world.recorded("session.settled")).toHaveLength(1);
      await reader.close();
    } finally {
      await world.close();
    }
  });

  it("compacts between tool batches of a running turn and never twice in that turn", async () => {
    const provider = parityProvider(
      [
        textTurn("ok"),
        toolCallTurn({
          type: "tool-call",
          callId: "r1",
          name: "read",
          arguments: { path: "big.txt" },
        }),
        textTurn("## Goal\nthe mid-run summary"),
        textTurn("done"),
      ],
      { capabilities: tinyWindow },
    );
    const world = await servedWorld(provider);
    await writeFile(join(world.cwd, "big.txt"), "b".repeat(6_000));
    const mostOfTheWindow = "y".repeat(13_000);
    try {
      const id = await world.createSession();
      const reader = await world.events();
      await world.post(`/sessions/${id}/prompt`, { text: "start" });
      await until(reader, (frame) => frame.event === "turn.completed");
      await until(reader, (frame) => frame.event === "session.state");
      await world.post(`/sessions/${id}/prompt`, { text: mostOfTheWindow });
      const settled = payloadOf<SessionSettlement>(
        await until(reader, (frame) => frame.event === "session.settled"),
      );
      expect(settled).toMatchObject({
        phase: "between-tool-batches",
        flushed: 0,
        compacted: { summary: expect.stringContaining("the mid-run summary") },
      });
      await until(reader, (frame) => frame.event === "turn.completed");
      await until(reader, (frame) => frame.event === "session.state");
      expect(world.recorded("session.settled")).toHaveLength(1);
      const lastRequest = provider.requests.at(-1);
      expect(JSON.stringify(lastRequest?.messages[0])).toContain("the mid-run summary");
      expect(JSON.stringify(lastRequest?.messages)).not.toContain(mostOfTheWindow);
      const stored = await findSession(world.sessionDir, id);
      const persisted = stored?.messages() ?? [];
      expect(JSON.stringify(persisted[0])).toContain("the mid-run summary");
      expect(persisted.slice(1).map((message) => message.role)).toEqual([
        "assistant",
        "tool",
        "assistant",
      ]);
      await reader.close();
    } finally {
      await world.close();
    }
  });
});

describe("serve parity: bot binding rebuilds the live agent", () => {
  it("runs the next prompt as the bot with its seeded model, announces session.state, and unbinds back", async () => {
    const base = parityProvider([textTurn("plain")], { modelId: "base" });
    const large = parityProvider([textTurn("as the scribe"), textTurn("plain again")], {
      modelId: "large",
    });
    const world = await servedWorld(base, {
      inference: inferenceOver({ "mock/large": large }),
      bots: { scribe: "---\nmodel: mock/large\n---\nYou are the scribe." },
    });
    try {
      const id = await world.createSession();
      const reader = await world.events();
      expect(await world.json(`/sessions/${id}/bot`, { name: "scribe" })).toEqual({
        bot: "scribe",
      });
      const bound = payloadOf<SessionState>(
        await until(reader, (frame) => frame.event === "session.state"),
      );
      expect(bound).toMatchObject({ bot: "scribe", model: "mock/large" });
      expect((await findSession(world.sessionDir, id))?.modelSelection()).toMatchObject({
        provider: "mock",
        modelId: "large",
      });

      await world.post(`/sessions/${id}/prompt`, { text: "who are you" });
      await until(reader, (frame) => frame.event === "turn.completed");
      await until(reader, (frame) => frame.event === "session.state");
      expect(large.requests[0]?.systemPrompt).toContain("You are the scribe.");
      expect(base.requests).toHaveLength(0);

      expect(await world.json(`/sessions/${id}/bot`, { name: null })).not.toHaveProperty("bot");
      const unbound = payloadOf<SessionState>(
        await until(reader, (frame) => frame.event === "session.state"),
      );
      expect(unbound.bot).toBeUndefined();
      expect(unbound.model).toBe("mock/large");
      await world.post(`/sessions/${id}/prompt`, { text: "and now" });
      await until(reader, (frame) => frame.event === "turn.completed");
      expect(large.requests[1]?.systemPrompt).not.toContain("You are the scribe.");
      await reader.close();
    } finally {
      await world.close();
    }
  });

  it("refuses to rebind while a turn is running", async () => {
    const world = await servedWorld(stallingProvider(), {
      bots: { scribe: "---\n---\nYou are the scribe." },
    });
    try {
      const id = await world.createSession();
      const reader = await world.events();
      await world.post(`/sessions/${id}/prompt`, { text: "stall" });
      await until(reader, (frame) => frame.event === "turn.delta");
      const refused = await world.post(`/sessions/${id}/bot`, { name: "scribe" });
      expect(refused.status).toBe(409);
      await world.post(`/sessions/${id}/abort`);
      await until(reader, (frame) => frame.event === "turn.interrupted");
      await reader.close();
    } finally {
      await world.close();
    }
  });
});

describe("serve parity: closing an arc", () => {
  it("flushes the bound live session into the arc layer and runs the closing judgment before the airlock", async () => {
    const provider = parityProvider([textTurn("noted")], {
      flushReply: "- the serve rule: close with a flush",
      distilledTitle: "Serve Close Digest",
    });
    const world = await servedWorld(provider);
    try {
      expect(await world.json("/arcs", { slug: "alpha" }, 201)).toMatchObject({ slug: "alpha" });
      const id = await world.createSession();
      const reader = await world.events();
      await world.post(`/sessions/${id}/prompt`, { text: "remember the serve rule" });
      await until(reader, (frame) => frame.event === "turn.completed");
      await until(reader, (frame) => frame.event === "session.state");
      expect(await world.json(`/sessions/${id}/arc`, { slug: "alpha" })).toEqual({ arc: "alpha" });
      expect(
        payloadOf<SessionState>(await until(reader, (frame) => frame.event === "session.state")),
      ).toMatchObject({ arc: "alpha" });

      const outcome = await world.json(`/arcs/alpha/close`, { direction: "keep the serve rule" });
      expect(outcome).toEqual({ kind: "pending", candidates: 1, questions: 0, wedged: 0 });
      const vaultRoot = openWorkspaceMemory(world.cwd, true)?.vaultRoot ?? "";
      const layer = new ArcRegistry({ vaultRoot, trusted: true }).arcStore("alpha");
      const arcDaily = await layer.readDaily();
      expect(arcDaily?.map((entry) => entry.text)).toEqual([
        "- the serve rule: close with a flush",
      ]);
      const digest = await world.json<{
        candidates: Array<{ note: string }>;
        sweep: { acked: number; wedged: number };
        direction?: string;
      }>("/arcs/alpha/airlock");
      expect(digest.candidates.map((candidate) => candidate.note)).toEqual(["Serve Close Digest"]);
      expect(digest.sweep).toEqual({ acked: 1, wedged: 0 });
      expect(digest.direction).toBe("keep the serve rule");
      expect(provider.requests.at(-1)?.systemPrompt).toContain("keep the serve rule");
      expect(
        world.recorded("surface.changed").map((payload) => (payload as { kind: string }).kind),
      ).toContain("arcs");
      await reader.close();
    } finally {
      await world.close();
    }
  });
});

describe("serve parity: the exit sweep", () => {
  it("runs the pane's close sweep over the vault when the host closes", async () => {
    const world = await servedWorld(parityProvider([textTurn("ok")]));
    const memory = openWorkspaceMemory(world.cwd, true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    const id = await world.createSession();
    const reader = await world.events();
    await world.post(`/sessions/${id}/prompt`, { text: "hello" });
    await until(reader, (frame) => frame.event === "session.state");
    await reader.close();
    const auditFile = join(world.cwd, ".keywork", "memory", "curation.md");
    await expect(readFile(auditFile, "utf8")).rejects.toThrow();
    await world.close();
    expect(await readFile(auditFile, "utf8")).toContain("gardener sweep");
  });
});

interface ParityProviderOptions {
  modelId?: string;
  capabilities?: ModelCapabilities;
  flushReply?: string;
  distilledTitle?: string;
}

interface ParityProvider extends Provider {
  requests: ProviderRequest[];
}

function parityProvider(turns: TurnDelta[][], options: ParityProviderOptions = {}): ParityProvider {
  const inner = new MockProvider(turns, {
    ...(options.modelId !== undefined && { modelId: options.modelId }),
    ...(options.capabilities !== undefined && { capabilities: options.capabilities }),
  });
  const requests: ProviderRequest[] = [];
  const reply = (text: string): TurnDelta[] => textTurn(text);
  return {
    name: inner.name,
    modelId: inner.modelId,
    capabilities: inner.capabilities,
    requests,
    async *stream(request) {
      requests.push(request);
      const last = request.messages.at(-1);
      if (last?.role === "user" && isMemoryFlushPrompt(messageText(last))) {
        yield* reply(options.flushReply ?? "NO_REPLY");
      } else if (request.systemPrompt.startsWith("You curate")) {
        yield* reply('{"relation": "distinct", "confidence": 0}');
      } else if (request.systemPrompt.startsWith("You are the closing distiller")) {
        const entryId = /\d{4}-\d{2}-\d{2}#\d+/.exec(messageText(last as Message))?.[0];
        const proposal = {
          entryId,
          title: options.distilledTitle ?? "Digest",
          body: "distilled under serve\n",
          confidence: 0.95,
        };
        yield* reply(JSON.stringify([proposal]));
      } else {
        yield* inner.stream(request);
      }
    },
  };
}

function stallingProvider(): Provider {
  return {
    name: "stalling",
    async *stream(request): AsyncIterable<TurnDelta> {
      yield { type: "text", text: "..." };
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      request.signal?.throwIfAborted();
    },
  };
}

function inferenceOver(providers: Readonly<Record<string, Provider>>): SessionInference {
  return {
    bind: (reference) => {
      const parsed = parseReference(reference);
      if (parsed === undefined || providers[reference] === undefined) {
        return {
          ok: false,
          failure: {
            code: "unknown-model",
            message: `no model matches ${reference}`,
            reference,
            provider: parsed?.provider,
            known: Object.keys(providers),
          },
        };
      }
      return { ok: true, binding: fakeBinding(parsed.provider, parsed.model) };
    },
    provider: (binding) => providers[formatReference(binding.reference)] ?? new MockProvider([]),
  };
}

function fakeBinding(provider: string, model: string): InferenceBinding {
  return {
    reference: { provider, model },
    registration: {
      name: provider,
      protocol: "chat-completions",
      endpoint: "https://example.test/v1",
      credential: { kind: "none" },
      models: [{ id: model, origin: "declared" }],
      openCatalog: true,
      enabled: true,
    },
    spec: { id: model, origin: "declared" },
    protocol: "chat-completions",
    capabilities: { input: ["text"], toolCalls: true },
    credential: undefined,
  };
}

interface WorldOptions {
  inference?: SessionInference;
  bots?: Record<string, string>;
}

async function servedWorld(provider: Provider, options: WorldOptions = {}) {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "parity" }));
  for (const [slug, definition] of Object.entries(options.bots ?? {})) {
    await mkdir(join(cwd, ".keywork", "bots", slug), { recursive: true });
    await writeFile(join(cwd, ".keywork", "bots", slug, "bot.md"), definition);
  }
  const sessionDir = await tempDir();
  const log = new EventLog();
  const hostOptions: HostOptions & { log: EventLog } = {
    cwd,
    sessionDir,
    userRoot: await tempDir(),
    projectTrusted: true,
    provider,
    permissions: () => "allow",
    checkpoints: "off",
    log,
    ...(options.inference !== undefined && { inference: options.inference }),
  };
  const host = await servedHost(hostOptions);
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const call = (path: string, init: RequestInit = {}) =>
    server.fetch(
      new Request(`http://keywork.test${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      }),
    );
  const post = (path: string, body?: unknown) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const json = async <Shape>(path: string, body?: unknown, status = 200): Promise<Shape> => {
    const response = body === undefined ? await call(path) : await post(path, body);
    expect(response.status).toBe(status);
    return (await response.json()) as Shape;
  };
  return {
    cwd,
    sessionDir,
    call,
    post,
    json,
    createSession: async () => ((await (await post("/sessions")).json()) as { id: string }).id,
    events: async () => sseReader(await call("/events")),
    recorded: (type: string) =>
      log
        .since(0)
        .filter((envelope) => envelope.type === type)
        .map((envelope) => envelope.payload),
    close: () => server.close(),
  };
}

function payloadOf<Shape>(frame: SseFrame): Shape {
  return (JSON.parse(frame.data) as { payload: Shape }).payload;
}

async function until(reader: SseReader, done: (frame: SseFrame) => boolean): Promise<SseFrame> {
  const seen: string[] = [];
  for (;;) {
    const frame = await Promise.race([reader.next(), silence(seen)]);
    if (done(frame)) return frame;
    seen.push(`${frame.event}${frame.event === "engine.error" ? `:${frame.data}` : ""}`);
  }
}

function silence(seen: readonly string[]): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`the stream went quiet after: ${seen.join(", ") || "(nothing)"}`)),
      waitLimitMs,
    ),
  );
}

const waitLimitMs = 3_000;
