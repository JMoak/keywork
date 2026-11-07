import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArcRegistry,
  type CreatureDetail,
  type CreatureHost,
  creatureTagOf,
  EndpointUnreachableError,
  filePairStore,
  formatReference,
  type InferenceBinding,
  inboundBlockHeading,
  isMemoryFlushPrompt,
  type Message,
  MockProvider,
  type ModelCapabilities,
  meshPairingFile,
  messageText,
  type ProbeHttp,
  type Provider,
  type ProviderRequest,
  parseReference,
  type ReportMark,
  type RunRow,
  type SessionEntry,
  type TurnDelta,
  textTurn,
  toolCallTurn,
  type Usage,
} from "@keywork/engine";
import {
  type BusEnvelope,
  createKeyworkServer,
  EventLog,
  type SessionInference,
  type SessionSettlement,
  type SessionState,
} from "@keywork/server";
import { type SseFrame, type SseReader, sseReader } from "@keywork/server/testing";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { waitingOnAnswer } from "../../engine/src/routines/scheduler.ts";
import { heldOnGrants, parkedRun } from "../../engine/src/routines/testing.ts";
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

describe("serve parity: a creature's chore, end to end", () => {
  it("runs a manual chore in a tagged routine thread, refuses its writes, reports one line to the conversation without a turn, and meters it", async () => {
    const provider = parityProvider([
      mutatingTurn(meteredAt(0.002)),
      textTurn("Nothing needs you today.\nThe inbox is quiet.", meteredAt(0.001)),
      textTurn("Noted.", meteredAt(0.0005)),
    ]);
    const world = await servedWorld(provider);
    try {
      const reader = await world.events();
      await world.json("/creatures", { name: "Pip" }, 201);
      await world.put("/creatures/pip/routines/triage", triageChore, 201);
      const fired = await world.json<{ run: RunRow }>(
        "/creatures/pip/routines/triage/run",
        {},
        202,
      );
      const seen = (await framesUntil(reader, finishedAndNoticed())).map(envelopeOf);
      await reader.close();

      const thread = fired.run.sessionId ?? "";
      expect(payloadsOf(seen, "routine.fired")).toEqual([
        expect.objectContaining({ creature: "pip", routineId: "triage", sessionId: thread }),
      ]);
      expect(payloadsOf(seen, "routine.finished")).toEqual([
        {
          run: expect.objectContaining({
            process: "completed",
            delivery: "delivered",
            sessionId: thread,
          }),
          disabled: null,
        },
      ]);
      expect(payloadsOf(seen, "creature.changed")).toEqual(
        expect.arrayContaining([
          { slug: "pip", change: "created" },
          { slug: "pip", change: "threads" },
        ]),
      );
      expect(
        seen
          .filter(
            (envelope) => envelope.type === "gate.permission" && envelope.sessionId === thread,
          )
          .map((envelope) => (envelope.payload as { decision: unknown }).decision),
      ).toEqual(
        ["write", "edit", "bash"].map((tool) =>
          expect.objectContaining({ tool, verdict: "denied", gate: "policy", asked: false }),
        ),
      );
      expect(seen.some((envelope) => envelope.type === "gate.ask")).toBe(false);
      expect(existsSync(join(world.cwd, "notes.md"))).toBe(false);

      const pip = await world.json<CreatureDetail>("/creatures/pip");
      expect(pip.threads).toEqual([
        expect.objectContaining({ id: thread, kind: "routine", title: "Morning triage" }),
      ]);
      const summary = 'Thread "Morning triage" finished: Nothing needs you today.';
      const conversation = await world.json<{ messages: Message[]; reports: ReportMark[] }>(
        `/sessions/${pip.conversation}`,
      );
      expect(conversation.messages).toEqual([]);
      expect(conversation.reports).toEqual([
        {
          index: 0,
          entryId: expect.any(String),
          at: expect.any(String),
          text: summary,
          origin: { kind: "creature", creature: "pip", thread },
        },
      ]);
      const { entries } = await world.json<{ entries: SessionEntry[] }>(
        `/sessions/${pip.conversation}/entries`,
      );
      expect(
        entries.filter(
          (entry) => entry.type === "custom" && entry.customType === "keywork.creature.report",
        ),
      ).toEqual([
        expect.objectContaining({
          data: { text: summary, origin: { kind: "creature", creature: "pip", thread } },
        }),
      ]);
      expect(
        seen
          .filter(
            (envelope) =>
              envelope.type === "extension.notice" && envelope.sessionId === pip.conversation,
          )
          .map((envelope) => envelope.payload),
      ).toEqual([
        {
          extension: "creature",
          level: "info",
          message: summary,
          detail: {
            origin: { kind: "creature", creature: "pip", thread },
            entryId: conversation.reports[0]?.entryId,
          },
        },
      ]);
      expect(
        seen.some(
          (envelope) => envelope.type === "turn.started" && envelope.sessionId === pip.conversation,
        ),
      ).toBe(false);
      expect(provider.requests).toHaveLength(2);

      const threadStore = await findSession(world.sessionDir, thread);
      expect(creatureTagOf(threadStore?.entries() ?? [])).toEqual({
        creature: "pip",
        kind: "routine",
      });
      expect(threadStore?.botBinding()).toBe("pip");
      expect(provider.requests[0]?.systemPrompt).toContain("You are Pip,");

      const runs = await world.json<{ runs: RunRow[] }>("/creatures/pip/routines/triage/runs");
      expect(runs.runs).toEqual([
        expect.objectContaining({
          process: "completed",
          delivery: "delivered",
          sessionId: thread,
          cost: { usd: 0.003 },
        }),
      ]);
      expect(pip.usage).toEqual({
        date: new Date().toISOString().slice(0, 10),
        sessions: 2,
        costNanos: 3_000_000,
      });
    } finally {
      await world.close();
    }
  });

  it("holds a write chore until the keeper accepts its grant set, then runs it", async () => {
    const provider = parityProvider([
      textTurn("Filed the notes.", meteredAt(0.001)),
      textTurn("Ok."),
    ]);
    const world = await servedWorld(provider);
    try {
      await world.json("/creatures", { name: "Pip" }, 201);
      await world.put("/creatures/pip/routines/triage", { ...triageChore, ...heldOnGrants }, 201);

      const held = await world.json<{ run: RunRow }>("/creatures/pip/routines/triage/run", {}, 200);
      expect(held.run).toMatchObject(parkedRun);
      expect(held.run.reason).toMatch(/waits until the keeper accepts that grant set/);
      expect(provider.requests).toHaveLength(0);

      const { routine } = await world.json<{ routine: { grants: { digest: string } } }>(
        "/creatures/pip/routines/triage",
      );
      const reader = await world.events();
      await world.json("/creatures/pip/routines/triage/accept", { digest: routine.grants.digest });
      await until(reader, (frame) => frame.event === "routine.fired");
      await until(reader, (frame) => frame.event === "routine.finished");
      await reader.close();
      const runs = await world.json<{ runs: RunRow[] }>("/creatures/pip/routines/triage/runs");
      expect(runs.runs).toHaveLength(1);
      expect(runs.runs[0]).toMatchObject({ runId: held.run.runId, process: "completed" });
      expect(runs.runs[0]?.sessionId).not.toBeNull();
    } finally {
      await world.close();
    }
  });
});

describe("serve parity: the node ports", () => {
  it("answers the creature, chore, model, workshop and mesh families instead of 503", async () => {
    const world = await servedWorld(parityProvider([]), { modelProbe: unreachableServers });
    try {
      await world.json("/creatures", { name: "Pip" }, 201);
      const answered = await Promise.all(
        ["/creatures", "/creatures/pip/routines", "/models", "/workshops", "/mesh/pairs"].map(
          async (path) => [path, (await world.call(path)).status] as const,
        ),
      );
      expect(answered).toEqual([
        ["/creatures", 200],
        ["/creatures/pip/routines", 200],
        ["/models", 200],
        ["/workshops", 200],
        ["/mesh/pairs", 200],
      ]);
    } finally {
      await world.close();
    }
  });

  it("streams workshop.changed, models.changed and the mesh events on GET /events", async () => {
    const world = await servedWorld(parityProvider([]), { modelProbe: unreachableServers });
    try {
      const pairId = await seedPair(world.userRoot);
      const reader = await world.events();
      await world.json("/workshops", { creature: "pip", substrate: "host" }, 201);
      await world.json("/models/probe", { endpoint: "http://127.0.0.1:11434" });
      await world.host.mesh?.pairing.unpair(pairId, "keeper");
      const seen = (await framesUntil(reader, (frame) => frame.event === "mesh.pair")).map(
        envelopeOf,
      );
      await reader.close();

      expect(payloadsOf(seen, "workshop.changed")).toEqual([
        {
          change: "created",
          workshop: expect.objectContaining({ creature: "pip", substrate: "host" }),
        },
      ]);
      expect(payloadsOf(seen, "models.changed")).toEqual([
        { node: expect.any(String), reason: "probe" },
      ]);
      expect(payloadsOf(seen, "mesh.pair")).toEqual([
        expect.objectContaining({ change: "removed", pairId, by: "keeper" }),
      ]);
    } finally {
      await world.close();
    }
  });

  it("keeps a creature's conversation out of the trash while the creature exists", async () => {
    const world = await servedWorld(parityProvider([]));
    try {
      await world.json("/creatures", { name: "Pip" }, 201);
      const { conversation } = await world.json<CreatureDetail>("/creatures/pip");
      const refused = await world.call(`/sessions/${conversation}`, { method: "DELETE" });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error:
          "the conversation of pip stays while the creature does · removing the creature removes it",
      });
      expect(await findSession(world.sessionDir, conversation)).toBeDefined();

      const removed = await world.call("/creatures/pip?confirmed=true", { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(await findSession(world.sessionDir, conversation)).toBeUndefined();
      expect((await world.json<{ bots: unknown[] }>("/bots")).bots).toEqual([]);
    } finally {
      await world.close();
    }
  });
});

const triageChore = {
  title: "Morning triage",
  instructions: "Read the inbox. Tell me only what needs me today.",
  trigger: { kind: "manual" },
};

const unreachableServers: ProbeHttp = {
  get: async (url) => {
    throw new EndpointUnreachableError(url, "nothing listens in this test");
  },
  post: async (url) => {
    throw new EndpointUnreachableError(url, "nothing listens in this test");
  },
};

function meteredAt(costUsd: number): Usage {
  return { inputTokens: 100, outputTokens: 10, costUsd };
}

function mutatingTurn(usage: Usage): TurnDelta[] {
  const call = (callId: string, name: string, args: unknown): TurnDelta => ({
    type: "tool-call",
    call: { type: "tool-call", callId, name, arguments: args },
  });
  return [
    call("w1", "write", { path: "notes.md", content: "x" }),
    call("e1", "edit", { path: "notes.md", oldText: "x", newText: "y" }),
    call("b1", "bash", { command: "echo hi > notes.md" }),
    { type: "done", usage },
  ];
}

async function seedPair(userRoot: string): Promise<string> {
  const pairId = "pair-1";
  filePairStore(meshPairingFile(join(userRoot, ".keywork", "node"))).write({
    owner: null,
    pairs: [
      {
        id: pairId,
        peerStableId: "nPeer",
        peerUserId: null,
        peerTags: [],
        peerDeviceKey: "peer-key",
        role: "node",
        caps: [],
        endpoint: null,
        createdAt: "2026-11-05T09:00:00.000Z",
        confirmedBy: "on-device",
      },
    ],
  });
  return pairId;
}

function envelopeOf(frame: SseFrame): BusEnvelope {
  return JSON.parse(frame.data) as BusEnvelope;
}

function payloadsOf(envelopes: readonly BusEnvelope[], type: string): unknown[] {
  return envelopes.filter((envelope) => envelope.type === type).map((envelope) => envelope.payload);
}

function finishedAndNoticed(): (frame: SseFrame) => boolean {
  const seen = new Set<string>();
  return (frame) => {
    if (frame.event === "routine.finished") seen.add("finished");
    if (
      frame.event === "extension.notice" &&
      payloadOf<{ extension: string }>(frame).extension === "creature"
    ) {
      seen.add("noticed");
    }
    return seen.size === 2;
  };
}

async function framesUntil(
  reader: SseReader,
  done: (frame: SseFrame) => boolean,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for (;;) {
    const frame = await Promise.race([
      reader.next(),
      silence(frames.map((seen) => `${seen.event}`)),
    ]);
    frames.push(frame);
    if (done(frame)) return frames;
  }
}

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
  permissions?: HostOptions["permissions"];
  inference?: SessionInference;
  bots?: Record<string, string>;
  modelProbe?: ProbeHttp;
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
  const userRoot = await tempDir();
  const log = new EventLog();
  const hostOptions: HostOptions & { log: EventLog } = {
    cwd,
    sessionDir,
    userRoot,
    projectTrusted: true,
    provider,
    permissions: options.permissions ?? (() => "allow"),
    checkpoints: "off",
    log,
    ...(options.inference !== undefined && { inference: options.inference }),
    ...(options.modelProbe !== undefined && { modelProbe: options.modelProbe }),
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
  const put = async (path: string, body: unknown, status = 200) => {
    const response = await call(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(status);
    return response.json();
  };
  return {
    cwd,
    sessionDir,
    userRoot,
    host,
    call,
    post,
    put,
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

describe("serve parity: a creature's conversation turn", () => {
  it("writes one report line after turn.completed, served as reports, and starts no further turn", async () => {
    const provider = parityProvider([
      textTurn("The kettle is on. I will say when it boils."),
      textTurn("never asked for"),
    ]);
    const world = await servedWorld(provider);
    try {
      await world.json("/creatures", { name: "Hal" }, 201);
      const hal = await world.json<CreatureDetail>("/creatures/hal");
      const reader = await world.events();
      await world.post(`/sessions/${hal.conversation}/prompt`, { text: "put the kettle on" });
      const seen = (await framesUntil(reader, reportedAfterTurn(hal.conversation))).map(envelopeOf);
      await reader.close();

      const origin = { kind: "creature", creature: "hal", thread: hal.conversation };
      const conversation = await world.json<{ reports: ReportMark[] }>(
        `/sessions/${hal.conversation}`,
      );
      expect(conversation.reports).toEqual([
        {
          index: 2,
          entryId: expect.any(String),
          at: expect.any(String),
          text: "The kettle is on.",
          origin,
        },
      ]);
      const ofConversation = seen.filter((envelope) => envelope.sessionId === hal.conversation);
      const kinds = ofConversation.map((envelope) => envelope.type);
      expect(kinds.indexOf("extension.notice")).toBeGreaterThan(kinds.indexOf("turn.completed"));
      expect(kinds.filter((kind) => kind === "turn.started")).toHaveLength(1);
      expect(payloadsOf(ofConversation, "extension.notice")).toEqual([
        {
          extension: "creature",
          level: "info",
          message: "The kettle is on.",
          detail: { origin, entryId: conversation.reports[0]?.entryId },
        },
      ]);
      expect(provider.requests).toHaveLength(1);
    } finally {
      await world.close();
    }
  });

  it("carries a delivered message into the next turn as an untrusted block, once, without a turn of its own", async () => {
    const provider = parityProvider([textTurn("Lark asked me to check notes."), textTurn("ok")]);
    const world = await servedWorld(provider);
    try {
      await world.json("/creatures", { name: "Hal" }, 201);
      await world.json("/creatures", { name: "Lark" }, 201);
      const hal = await world.json<CreatureDetail>("/creatures/hal");
      const creatures = world.host.creatures as CreatureHost;
      const origin = {
        kind: "creature" as const,
        creature: "lark",
        thread: "parityMessage1",
        node: "nParityHouse",
        machine: "house",
      };
      expect(await creatures.deliver("hal", "Message from lark: please check notes", origin)).toBe(
        "noted",
      );
      expect(provider.requests).toHaveLength(0);

      const reader = await world.events();
      await world.post(`/sessions/${hal.conversation}/prompt`, { text: "what did Lark say?" });
      await until(reader, (frame) => frame.event === "turn.completed");
      await world.post(`/sessions/${hal.conversation}/prompt`, { text: "and now?" });
      await until(reader, (frame) => frame.event === "turn.completed");
      await reader.close();

      expect(provider.requests[0]?.systemPrompt).toContain(
        `${inboundBlockHeading}\n- Message from lark: please check notes [untrusted, `,
      );
      expect(provider.requests[1]?.systemPrompt).not.toContain(inboundBlockHeading);
      expect(provider.requests[1]?.systemPrompt).not.toContain("please check notes");
    } finally {
      await world.close();
    }
  });
});

function reportedAfterTurn(sessionId: string): (frame: SseFrame) => boolean {
  let completed = false;
  return (frame) => {
    const envelope = envelopeOf(frame);
    if (envelope.sessionId !== sessionId) return false;
    if (envelope.type === "turn.completed") completed = true;
    return completed && envelope.type === "extension.notice";
  };
}

describe("serve parity: a creature in its bare host workshop", () => {
  it("finds its workshop running before the first turn and works in the workspace itself", async () => {
    const provider = parityProvider([
      [
        toolCall("r1", "read", { path: "docs/INDEX.md" }),
        toolCall("w1", "write", { path: "notes/largest.md", content: "docs/INDEX.md\n" }),
        { type: "done", usage: meteredAt(0.001) },
      ],
      textTurn("The list is in notes/largest.md."),
    ]);
    const world = await servedWorld(provider);
    try {
      await mkdir(join(world.cwd, "docs"), { recursive: true });
      await writeFile(join(world.cwd, "docs", "INDEX.md"), "# Index\n", "utf8");
      const made = await world.json<{ workshop: string }>(
        "/creatures",
        { name: "Osk", substrate: "host" },
        201,
      );
      expect(await world.json(`/workshops/${made.workshop}`)).toMatchObject({
        state: "running",
        workdir: world.cwd,
        workspace: { access: "direct", path: world.cwd },
      });

      const osk = await world.json<CreatureDetail>("/creatures/osk");
      const reader = await world.events();
      await world.post(`/sessions/${osk.conversation}/prompt`, {
        text: "list the five largest files under docs and write the list to notes/largest.md",
      });
      await until(reader, (frame) => frame.event === "turn.completed");
      await reader.close();

      const results = toolResultsOf(provider.requests.at(-1));
      expect(results.r1).toContain("# Index");
      expect(results.w1).toBe("Wrote notes/largest.md");
      expect(await readFile(join(world.cwd, "notes", "largest.md"), "utf8")).toBe(
        "docs/INDEX.md\n",
      );
    } finally {
      await world.close();
    }
  });

  it("runs an accepted parked chore as running while its session works, completed after, writing in the workspace", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = parityProvider([
      [
        toolCall("s1", "write", { path: "notes/stamp.md", content: "stamped\n" }),
        { type: "done", usage: meteredAt(0.001) },
      ],
      textTurn("Stamped notes/stamp.md."),
    ]);
    const provider: Provider = {
      name: inner.name,
      modelId: inner.modelId,
      capabilities: inner.capabilities,
      async *stream(request) {
        await gate;
        yield* inner.stream(request);
      },
    };
    const world = await servedWorld(provider);
    try {
      await world.json("/creatures", { name: "Osk", substrate: "host" }, 201);
      await world.put("/creatures/osk/routines/stamp", { ...triageChore, ...heldOnGrants }, 201);
      const held = await world.json<{ run: RunRow }>("/creatures/osk/routines/stamp/run", {}, 200);
      expect(held.run).toMatchObject(parkedRun);
      const { routine } = await world.json<{ routine: { grants: { digest: string } } }>(
        "/creatures/osk/routines/stamp",
      );

      const reader = await world.events();
      await world.json("/creatures/osk/routines/stamp/accept", { digest: routine.grants.digest });
      await until(reader, (frame) => frame.event === "routine.fired");
      const working = await world.json<{ runs: RunRow[] }>("/creatures/osk/routines/stamp/runs");
      release();
      await until(reader, (frame) => frame.event === "routine.finished");
      await reader.close();
      const finished = await world.json<{ runs: RunRow[] }>("/creatures/osk/routines/stamp/runs");

      expect(working.runs).toEqual([
        expect.objectContaining({ runId: held.run.runId, status: "running", reason: null }),
      ]);
      expect(working.runs[0]?.sessionId).not.toBeNull();
      expect(finished.runs).toEqual([
        expect.objectContaining({ runId: held.run.runId, status: "ended", process: "completed" }),
      ]);
      expect(await readFile(join(world.cwd, "notes", "stamp.md"), "utf8")).toBe("stamped\n");
    } finally {
      await world.close();
    }
  });
});

function toolCall(callId: string, name: string, args: unknown): TurnDelta {
  return { type: "tool-call", call: { type: "tool-call", callId, name, arguments: args } };
}

function toolResultsOf(request: ProviderRequest | undefined): Record<string, string> {
  const results: Record<string, string> = {};
  for (const message of request?.messages ?? []) {
    for (const part of message.parts) {
      if (part.type === "tool-result") results[part.callId] = String(part.output);
    }
  }
  return results;
}

describe("serve parity: a chore waiting on the keeper's answer", () => {
  it("names the ask on its parked row, then reads running once answered and completed after", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = parityProvider([
      [
        toolCall("w9", "write", { path: "stamp.md", content: "stamped\n" }),
        { type: "done", usage: meteredAt(0.001) },
      ],
      textTurn("Stamped."),
    ]);
    let streams = 0;
    const provider: Provider = {
      name: inner.name,
      modelId: inner.modelId,
      capabilities: inner.capabilities,
      async *stream(request) {
        streams += 1;
        if (streams === 2) await gate;
        yield* inner.stream(request);
      },
    };
    const world = await servedWorld(provider, { permissions: () => "ask" });
    try {
      await world.json("/creatures", { name: "Osk", substrate: "host" }, 201);
      await world.put("/creatures/osk/routines/stamp", { ...triageChore, ...heldOnGrants }, 201);
      await world.json("/creatures/osk/routines/stamp/run", {}, 200);
      const { routine } = await world.json<{ routine: { grants: { digest: string } } }>(
        "/creatures/osk/routines/stamp",
      );

      const reader = await world.events();
      await world.json("/creatures/osk/routines/stamp/accept", { digest: routine.grants.digest });
      await until(reader, (frame) => frame.event === "gate.ask");
      const waiting = await world.json<{ runs: RunRow[] }>("/creatures/osk/routines/stamp/runs");
      await world.json("/asks/w9", { verdict: "granted", scope: "once" });
      await until(reader, (frame) => frame.event === "gate.permission");
      const answered = await world.json<{ runs: RunRow[] }>("/creatures/osk/routines/stamp/runs");
      release();
      await until(reader, (frame) => frame.event === "routine.finished");
      await reader.close();
      const finished = await world.json<{ runs: RunRow[] }>("/creatures/osk/routines/stamp/runs");

      expect(waiting.runs[0]).toMatchObject({ status: "parked", reason: waitingOnAnswer("write") });
      expect(waiting.runs[0]?.sessionId).not.toBeNull();
      expect(answered.runs[0]).toMatchObject({ status: "running", reason: null });
      expect(finished.runs[0]).toMatchObject({ status: "ended", process: "completed" });
      expect(await readFile(join(world.cwd, "stamp.md"), "utf8")).toBe("stamped\n");
    } finally {
      await world.close();
    }
  });
});
