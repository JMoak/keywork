import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatReference,
  type InferenceBinding,
  type Message,
  MockProvider,
  type Provider,
  parseReference,
  SessionStore,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import {
  createKeyworkServer,
  EventLog,
  readServerTicket,
  type SessionHost,
  type SessionInference,
  writeServerTicket,
} from "@keywork/server";
import {
  memorySessionHost,
  type SseFrame,
  type SseReader,
  sseReader,
} from "@keywork/server/testing";
import { type ActivePreset, TrustStore } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { afterAll, describe, expect, it } from "vitest";
import { type ArcService, arcService } from "./arcs.ts";
import { composeWorkspace } from "./compose.ts";
import { arcLayerId, citationTrail, openWorkspaceMemory } from "./memory.ts";
import { keyworkHome } from "./paths.ts";
import {
  alreadyServingExit,
  fileSessionHost,
  type HostOptions,
  serve,
  servedHost,
  serverTicketFile,
  ticketFilesFor,
  workspaceInfoOf,
  workspaceTicketFile,
} from "./serve.ts";
import { servedMemory } from "./serve-memory.ts";
import { surfacePorts } from "./serve-surfaces.ts";
import { boundSessionCounts, sessionPort } from "./sessions/ports.ts";
import { findSession, scanSessions } from "./sessions/store.ts";
import { fileWorkspaceRecall, workspaceRecallFile } from "./workspaces.ts";

const tempDir = scratchDirs("keywork-serve-");
const emptyUserRoot = mkdtempSync(join(tmpdir(), "keywork-serve-user-"));
const token = "serve-test-token";

afterAll(() => rm(emptyUserRoot, { recursive: true, force: true }));

async function hostOptions(provider: MockProvider): Promise<HostOptions & { log: EventLog }> {
  return {
    cwd: await tempDir(),
    sessionDir: await tempDir(),
    projectTrusted: false,
    provider,
    permissions: () => "allow",
    userRoot: emptyUserRoot,
    log: new EventLog(),
  };
}

function serverOver(options: HostOptions & { log: EventLog }) {
  const host = fileSessionHost(options);
  const server = createKeyworkServer({ token, host, log: options.log, version: "test" });
  const call = (path: string, init: RequestInit = {}) =>
    server.fetch(
      new Request(`http://keywork.test${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      }),
    );
  return { server, host, call };
}

describe("servedHost", () => {
  it("mounts every route family over one composition so keywork serve answers them all", async () => {
    const options = { ...(await hostOptions(new MockProvider([]))), projectTrusted: true };
    const host = await servedHost(options);
    const server = createKeyworkServer({ token, host, log: options.log, version: "test" });
    const call = (path: string) =>
      server.fetch(
        new Request(`http://keywork.test${path}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );

    const answered = await Promise.all(
      ["/workspace", "/flavors", "/mcp", "/arcs", "/memory", "/bots", "/workspaces"].map(
        async (path) => [path, (await call(path)).status] as const,
      ),
    );

    expect(answered.every(([, status]) => status === 200)).toBe(true);
    await host.close();
  });

  it("keeps the session verbs of the file host", async () => {
    const options = {
      ...(await hostOptions(new MockProvider([textTurn("hi")]))),
      projectTrusted: true,
    };
    const host = await servedHost(options);

    const created = await host.create();
    expect((await host.list()).map((session) => session.id)).toContain(created.id);
    expect(await host.context(created.id)).not.toBe("missing");
    await host.close();
  });
});

describe("fileSessionHost", () => {
  it("creates a session, runs a tool-using turn on prompt, streams it, and persists it", async () => {
    const options = await hostOptions(
      new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "c1",
          name: "bash",
          arguments: { command: "echo served" },
        }),
        textTurn("all done"),
      ]),
    );
    const { server, call } = serverOver(options);
    const created = await call("/sessions", { method: "POST" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const reader = sseReader(await call("/events"));

    const accepted = await call(`/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "echo something" }),
    });
    expect(accepted.status).toBe(202);
    const types: string[] = [];
    while (types.at(-1) !== "turn.completed") types.push((await reader.next()).event ?? "");
    expect(types[0]).toBe("turn.started");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.output");
    expect(types).toContain("tool.finished");
    await reader.close();
    await server.close();

    const { stores } = await scanSessions(options.sessionDir ?? "");
    expect(stores).toHaveLength(1);
    const messages = stores[0]?.messages() ?? [];
    expect(messages[0]?.role).toBe("user");
    expect(messages.at(-1)?.parts).toEqual([{ type: "text", text: "all done" }]);
  });

  it("lists and reads sessions already on disk, and answers idle or missing on abort", async () => {
    const options = await hostOptions(new MockProvider([]));
    const stored = await SessionStore.create(
      join(options.sessionDir ?? "", "1-0001-1.jsonl"),
      options.cwd,
    );
    const question: Message = { role: "user", parts: [{ type: "text", text: "earlier question" }] };
    await stored.append(question);
    const { server, host, call } = serverOver(options);

    const listed = (await (await call("/sessions")).json()) as {
      sessions: Array<{ id: string; title: string; messageCount: number }>;
    };
    expect(listed.sessions).toEqual([
      expect.objectContaining({ id: stored.header.id, title: "earlier question", messageCount: 1 }),
    ]);
    const read = await call(`/sessions/${stored.header.id}`);
    expect(await read.json()).toMatchObject({
      id: stored.header.id,
      live: false,
      messages: [question],
    });
    expect(await host.abort(stored.header.id)).toBe("idle");
    expect(await host.abort("nope")).toBe("missing");
    expect(await host.prompt("nope", "hi")).toBe("missing");
    await server.close();
  });

  it("routes an ask to a client and resumes with its verdict, or times out as headless", async () => {
    const askingTurns = () =>
      new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "c1",
          name: "bash",
          arguments: { command: "rm x" },
        }),
        textTurn("gave up"),
      ]);
    const answered = await hostOptions(askingTurns());
    answered.permissions = () => "ask";
    const first = serverOver(answered);
    const { id } = (await (await first.call("/sessions", { method: "POST" })).json()) as {
      id: string;
    };
    const reader = sseReader(await first.call("/events"));
    await first.call(`/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "rm" }),
    });
    for (;;) {
      const frame = await reader.next();
      if (frame.event !== "gate.ask") continue;
      expect(JSON.parse(frame.data).payload.ask).toMatchObject({
        tool: "bash",
        callId: "c1",
        rule: "policy",
      });
      break;
    }
    const pending = (await (await first.call("/asks")).json()) as { asks: unknown[] };
    expect(pending.asks).toHaveLength(1);
    const settled = await first.call("/asks/c1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "denied" }),
    });
    expect(settled.status).toBe(200);
    for (;;) {
      const frame = await reader.next();
      if (frame.event !== "gate.permission") continue;
      expect(JSON.parse(frame.data).payload.decision).toMatchObject({
        gate: "user",
        verdict: "denied",
        tool: "bash",
      });
      break;
    }
    await reader.close();
    await first.server.close();

    const unanswered = await hostOptions(askingTurns());
    unanswered.permissions = () => "ask";
    unanswered.askTimeoutMs = 20;
    const second = serverOver(unanswered);
    const created = (await (await second.call("/sessions", { method: "POST" })).json()) as {
      id: string;
    };
    const stream = sseReader(await second.call("/events"));
    await second.call(`/sessions/${created.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "rm" }),
    });
    for (;;) {
      const frame = await stream.next();
      if (frame.event !== "gate.permission") continue;
      expect(JSON.parse(frame.data).payload.decision).toMatchObject({
        gate: "headless",
        verdict: "denied",
      });
      break;
    }
    await stream.close();
    await second.server.close();
  });
});

describe("serve", () => {
  it("prints the URL and token, writes the ticket, answers over the socket, and cleans up on abort", async () => {
    const options = await hostOptions(new MockProvider([]));
    const ticketFile = join(await tempDir(), "server.json");
    const out: string[] = [];
    const interrupts = new AbortController();
    const finished = serve({
      ...options,
      port: 0,
      ticketFile,
      signal: interrupts.signal,
      print: (line) => out.push(line),
      printError: () => undefined,
    });
    while (out.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    const url = out[0]?.replace("listening on ", "") ?? "";
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const token = out[1]?.replace("token ", "") ?? "";
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(out[2]).toBe(`ticket ${ticketFile}`);
    expect(readServerTicket(ticketFile)).toEqual({ url, token });
    expect(JSON.parse(await readFile(ticketFile, "utf8"))).toEqual({ url, token });

    expect((await fetch(`${url}/sessions`)).status).toBe(401);
    const listed = await fetch(`${url}/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await listed.json()).toEqual({ sessions: [] });

    interrupts.abort();
    expect(await finished).toBe(0);
    expect(readServerTicket(ticketFile)).toBeUndefined();
    await expect(fetch(`${url}/doc`)).rejects.toThrow();
  });

  it("fails with exit 1 and a message when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    const errors: string[] = [];
    try {
      const code = await serve({
        ...(await hostOptions(new MockProvider([]))),
        port,
        ticketFile: join(await tempDir(), "server.json"),
        signal: new AbortController().signal,
        print: () => undefined,
        printError: (line) => errors.push(line),
      });
      expect(code).toBe(1);
      expect(errors[0]).toMatch(/^keywork serve: .*EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("memorySessionHost parity", () => {
  it("runs an injected prompt as an ordinary turn tagged with its client, and persists it", async () => {
    const options = await hostOptions(new MockProvider([textTurn("heard you")]));
    const { server, host, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call("/events"));

    const accepted = await call(`/sessions/${id}/inject`, {
      method: "POST",
      body: JSON.stringify({ text: "dictated prompt", client: "wispr-flow" }),
    });
    expect(await accepted.json()).toEqual({ sessionId: id, accepted: true, queued: false });
    const started = await reader.next();
    expect(JSON.parse(started.data).payload).toEqual({
      userText: "dictated prompt",
      origin: { kind: "external", client: "wispr-flow" },
    });
    while ((await reader.next()).event !== "turn.completed");
    await reader.close();
    expect(await host.inject("nope", "hi", { kind: "external", client: "x" })).toBe("missing");
    await server.close();

    const { stores } = await scanSessions(options.sessionDir ?? "");
    expect(stores[0]?.messages().map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("answers the same host contract as the file host for unknown sessions", async () => {
    const host = memorySessionHost({ log: new EventLog(), provider: new MockProvider([]) });
    expect(await host.prompt("nope", "hi")).toBe("missing");
    expect(await host.abort("nope")).toBe("missing");
    expect(await host.read("nope")).toBeUndefined();
  });
});

describe("serve discovery", () => {
  async function startServe(cwd: string, userRoot: string, port = 0) {
    const options = await hostOptions(new MockProvider([]));
    const out: string[] = [];
    const errors: string[] = [];
    const interrupts = new AbortController();
    const finished = serve({
      ...options,
      cwd,
      userRoot,
      port,
      signal: interrupts.signal,
      print: (line) => out.push(line),
      printError: (line) => errors.push(line),
    });
    return { out, errors, interrupts, finished };
  }

  it("writes the workspace ticket and the user-level fallback, refuses a second serve beside a live one, and clears a stale ticket", async () => {
    const cwd = await tempDir();
    const userRoot = await tempDir();
    const first = await startServe(cwd, userRoot);
    while (first.out.length < 4) await new Promise((resolve) => setTimeout(resolve, 5));
    const url = first.out[0]?.replace("listening on ", "") ?? "";
    const files = ticketFilesFor(cwd, undefined, userRoot);
    expect(first.out.slice(2)).toEqual(files.map((file) => `ticket ${file}`));
    expect(files[0]).toBe(workspaceTicketFile(cwd, undefined, userRoot));
    expect(files[1]).toBe(serverTicketFile(userRoot));
    for (const file of files) expect(readServerTicket(file)?.url).toBe(url);
    const doc = (await (await fetch(`${url}/doc`)).json()) as {
      info: { workspace: { anchor: string; identity: string } };
    };
    expect(doc.info.workspace).toEqual(workspaceInfoOf(cwd));

    const second = await startServe(cwd, userRoot);
    expect(await second.finished).toBe(alreadyServingExit);
    expect(second.errors[0]).toContain(`already listening at ${url}`);

    first.interrupts.abort();
    expect(await first.finished).toBe(0);
    for (const file of files) expect(readServerTicket(file)).toBeUndefined();

    writeServerTicket(files[0] ?? "", { url, token: "stale" });
    const third = await startServe(cwd, userRoot);
    while (third.out.length < 4) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(readServerTicket(files[0] ?? "")?.token).not.toBe("stale");
    third.interrupts.abort();
    expect(await third.finished).toBe(0);
  });
});

describe("the memory family over a served vault (K4)", () => {
  const closeTime = "2026-08-21T12:00:00.000Z";
  const vaultWalkTimeoutMs = 30_000;

  async function declaredWorkspace(): Promise<string> {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "fixture" }));
    return cwd;
  }

  async function servedWorld(options: { trusted?: boolean; wedge?: string } = {}) {
    const cwd = await declaredWorkspace();
    const trusted = options.trusted ?? true;
    const memory = openWorkspaceMemory(cwd, trusted);
    if (memory === undefined) throw new Error("expected workspace memory");
    const sessionDir = await tempDir();
    const flushed: string[] = [];
    const citations = citationTrail(() => memory);
    const arcs: ArcService = arcService({
      cwd,
      trusted,
      memory: () => memory,
      boundSessionCounts: () => boundSessionCounts(sessionDir),
      now: () => new Date(closeTime),
      citedNotes: (slug) => citations.citedNotes(slug),
      flushFor: (sessionId) => {
        if (sessionId === options.wedge) return undefined;
        return async () => {
          flushed.push(sessionId);
          await arcs.layerStoreFor(sessionId)?.appendDaily(`flushed by ${sessionId}`, "agent");
        };
      },
    });
    const log = new EventLog();
    const host: SessionHost = {
      ...fileSessionHost({
        cwd,
        sessionDir,
        projectTrusted: trusted,
        provider: new MockProvider([]),
        permissions: () => "allow",
        userRoot: emptyUserRoot,
        log,
      }),
      memory: servedMemory({ memory: () => memory, arcs }),
    };
    const server = createKeyworkServer({ token, host, log, version: "test" });
    const call = (path: string, init: RequestInit = {}) =>
      server.fetch(
        new Request(`http://keywork.test${path}`, {
          ...init,
          headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        }),
      );
    const post = async <Shape>(path: string, body?: unknown): Promise<Shape> => {
      const response = await call(path, {
        method: "POST",
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
      return (await response.json()) as Shape;
    };
    const get = async <Shape>(path: string): Promise<Shape> =>
      (await (await call(path)).json()) as Shape;
    const inboxCounts = (): number[] =>
      log
        .since(0)
        .filter((envelope) => envelope.type === "memory.inbox")
        .map((envelope) => (envelope.payload as { count: number }).count);
    return { cwd, memory, arcs, citations, flushed, server, call, post, get, inboxCounts };
  }

  async function arcAtTheAirlock(world: Awaited<ReturnType<typeof servedWorld>>) {
    const registry = world.arcs.registry();
    if (registry === undefined) throw new Error("expected a registry");
    await world.arcs.port.create("dock-v2");
    await world.arcs.port.create("next-arc");
    const layer = registry.arcStore("dock-v2");
    await layer.writeNote({
      title: "Dock Ratio Finding",
      body: "Docks split 50/50 by default.\n",
      provenance: "agent",
    });
    await layer.writeNote({
      title: "Uncited Hunch",
      body: "Thirds, maybe.\n",
      provenance: "agent",
    });
    const ledger = world.citations.forSession("s1");
    ledger.recordRecall("Dock Ratio Finding", "search", arcLayerId("dock-v2"));
    ledger.recordReply("per [[Dock Ratio Finding]]");
    const questions = registry.openQuestions("dock-v2");
    for (const title of ["Tie order", "Theme drift", "Old worry"]) {
      await questions.add({ title, body: `${title}?`, provenance: "user" });
    }
    world.arcs.recordBinding("s1", "dock-v2");
    world.arcs.recordBinding("s2", "dock-v2");
    return registry;
  }

  interface Digest {
    trusted: boolean;
    arc: string;
    candidates: Array<{ note: string; eligible: boolean; shortfalls: string[]; choice?: string }>;
    questions: Array<{ title: string; choice?: string }>;
    successor?: string;
    sweep?: { acked: number; wedged: number };
    decisions: { candidates: Record<string, string>; questions: Record<string, string> };
  }

  it("answers the inert shape against an untrusted workspace", async () => {
    const world = await servedWorld({ trusted: false });
    expect(await world.get("/memory")).toEqual({
      trusted: false,
      layers: [],
      inbox: [],
      ledger: [],
      audit: [],
      airlocks: [],
    });
    const refused = await world.call("/arcs/dock-v2/airlock/deliver", { method: "POST" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "memory is inert: this workspace is untrusted" });
    await world.server.close();
  });

  it(
    "lists the workspace and active arc layers with their notes and the digests waiting at the airlock",
    async () => {
      const world = await servedWorld();
      await world.memory.store.writeNote({
        title: "Shared Rule",
        body: "shared\n",
        provenance: "user",
      });
      await arcAtTheAirlock(world);
      await world.arcs.port.close("dock-v2");

      const overview = await world.get<{
        layers: Array<{ id: string; kind: string; arc?: string }>;
        inbox: Array<{ kind: string }>;
        airlocks: Array<{ arc: string }>;
      }>("/memory");
      expect(overview.layers.map((layer) => layer.id)).toEqual([
        "workspace",
        "arc:dock-v2",
        "arc:next-arc",
      ]);
      expect(overview.inbox.map((item) => item.kind).sort()).toEqual([
        "arc-distillation",
        "arc-distillation",
        "arc-question",
        "arc-question",
        "arc-question",
      ]);
      expect(overview.airlocks.map((digest) => digest.arc)).toEqual(["dock-v2"]);

      const notes = await world.get<{ notes: Array<{ name: string; layer: string }> }>(
        "/memory/notes?layer=arc:dock-v2",
      );
      expect(notes.notes.map((note) => note.name).sort()).toEqual([
        "Dock Ratio Finding",
        "Uncited Hunch",
      ]);
      const shared = await world.get<{ name: string; layer: string; relations: unknown[] }>(
        "/memory/notes/Shared%20Rule",
      );
      expect(shared).toMatchObject({ name: "Shared Rule", layer: "workspace", relations: [] });
      await world.server.close();
    },
    vaultWalkTimeoutMs,
  );

  it(
    "walks the airlock over HTTP: digest, triage, deliver, finish, mirroring the arc service's own cases",
    async () => {
      const world = await servedWorld();
      const registry = await arcAtTheAirlock(world);
      expect(await world.arcs.port.close("dock-v2")).toEqual({
        kind: "pending",
        candidates: 2,
        questions: 3,
        wedged: 0,
      });
      expect(world.flushed.sort()).toEqual(["s1", "s2"]);

      const digest = await world.get<Digest>("/arcs/dock-v2/airlock");
      expect(digest.trusted).toBe(true);
      expect(digest.sweep).toEqual({ acked: 2, wedged: 0 });
      expect(digest.candidates.map((c) => [c.note, c.eligible, c.shortfalls])).toEqual([
        ["Dock Ratio Finding", true, []],
        ["Uncited Hunch", false, ["uncited"]],
      ]);
      expect(digest.questions.map((q) => q.title).sort()).toEqual([
        "Old worry",
        "Theme drift",
        "Tie order",
      ]);
      expect((await world.call("/arcs/next-arc/airlock")).status).toBe(404);

      const undecided = await world.post<{ kind: string; items: string[] }>(
        "/arcs/dock-v2/airlock/finish",
      );
      expect(undecided.kind).toBe("undecided");
      expect([...undecided.items].sort()).toEqual([
        "Dock Ratio Finding",
        "Old worry",
        "Theme drift",
        "Tie order",
      ]);
      expect(
        (await world.get<Digest>("/arcs/dock-v2/airlock")).candidates.map((c) => c.choice),
      ).toEqual([undefined, "leave"]);
      const below = await world.call("/arcs/dock-v2/airlock/candidates/Uncited%20Hunch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choice: "deliver" }),
      });
      expect(below.status).toBe(409);
      expect(await world.post("/arcs/dock-v2/airlock/deliver")).toEqual({ delivered: 1 });
      await world.post("/arcs/dock-v2/airlock/questions", {
        title: "Tie order",
        choice: "resolve",
      });
      await world.post("/arcs/dock-v2/airlock/questions", {
        title: "Theme drift",
        choice: "carry",
      });
      const decided = await world.post<Digest>("/arcs/dock-v2/airlock/questions", {
        title: "Old worry",
        choice: "drop",
      });
      expect(decided.successor).toBe("next-arc");
      expect(decided.candidates.map((c) => c.choice)).toEqual(["deliver", "leave"]);
      expect(decided.decisions).toEqual({
        candidates: { "Dock Ratio Finding": "deliver", "Uncited Hunch": "leave" },
        questions: { "Tie order": "resolve", "Theme drift": "carry", "Old worry": "drop" },
        successor: "next-arc",
      });

      expect(await world.post("/arcs/dock-v2/airlock/finish")).toEqual({
        kind: "closed",
        delivered: 1,
        released: 2,
      });
      const delivered = await world.memory.store.readNote("Dock Ratio Finding");
      expect(delivered?.delivered).toBe(closeTime);
      expect(await world.memory.store.readNote("Uncited Hunch")).toBeUndefined();
      expect((await registry.openQuestions("next-arc").open()).map((q) => q.title)).toEqual([
        "Theme drift",
      ]);
      expect((await world.call("/arcs/dock-v2/airlock")).status).toBe(404);
      expect(world.inboxCounts().at(-1)).toBe(0);
      expect(new Set(world.inboxCounts()).size).toBeGreaterThan(1);
      await world.server.close();
    },
    vaultWalkTimeoutMs,
  );

  it(
    "refuses to finish past a wedged session until forced",
    async () => {
      const world = await servedWorld({ wedge: "s2" });
      await arcAtTheAirlock(world);
      expect(await world.arcs.port.close("dock-v2")).toMatchObject({ kind: "pending", wedged: 1 });
      expect((await world.get<Digest>("/arcs/dock-v2/airlock")).sweep).toEqual({
        acked: 1,
        wedged: 1,
      });
      await world.post("/arcs/dock-v2/airlock/deliver");
      for (const title of ["Tie order", "Theme drift", "Old worry"]) {
        await world.post("/arcs/dock-v2/airlock/questions", { title, choice: "drop" });
      }
      expect(await world.post("/arcs/dock-v2/airlock/finish")).toEqual({
        kind: "wedged",
        sessions: ["s2"],
      });
      expect(await world.post("/arcs/dock-v2/airlock/finish", { force: true })).toEqual({
        kind: "closed",
        delivered: 1,
        released: 2,
      });
      expect(world.flushed).toEqual(["s1"]);
      await world.server.close();
    },
    vaultWalkTimeoutMs,
  );

  it(
    "carrying a question needs a successor arc and names the newest one",
    async () => {
      const orphaned = await servedWorld();
      await arcAtTheAirlock(orphaned);
      await orphaned.arcs.port.abandon("next-arc");
      await orphaned.arcs.port.close("dock-v2");
      const refused = await orphaned.call("/arcs/dock-v2/airlock/questions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Tie order", choice: "carry" }),
      });
      expect(refused.status).toBe(409);
      await orphaned.arcs.port.create("later-arc");
      const carried = await orphaned.post<Digest>("/arcs/dock-v2/airlock/questions", {
        title: "Tie order",
        choice: "carry",
      });
      expect(carried.successor).toBe("later-arc");
      await orphaned.server.close();
    },
    vaultWalkTimeoutMs,
  );

  it(
    "approves a staged note through the served port and fires memory.inbox with the new count",
    async () => {
      const world = await servedWorld();
      await world.memory.store.writeNote({
        title: "Hunch",
        body: "maybe\n",
        provenance: "untrusted",
      });
      await world.memory.store.propose([
        { kind: "forget-proposal", session: "s9", notes: [], entries: [] },
      ]);
      const inbox = await world.get<{ items: Array<{ id: string; kind: string }>; count: number }>(
        "/memory/inbox",
      );
      expect(inbox.items.map((item) => item.kind)).toEqual(["note", "forget-proposal"]);
      const staged = inbox.items.find((item) => item.kind === "note");
      expect(await world.post(`/memory/inbox/${staged?.id}/approve`)).toMatchObject({
        path: "Hunch.md",
        staged: false,
      });
      expect(await world.memory.store.readNote("Hunch")).toBeDefined();
      expect(world.inboxCounts()).toEqual([1]);
      await world.server.close();
    },
    vaultWalkTimeoutMs,
  );
});

describe("K0 and K1 under serve: checkpoints, per-session inference, and the verbs over JSONL", () => {
  const post = (call: ReturnType<typeof serverOver>["call"], path: string, body?: unknown) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const payloadOf = (frame: SseFrame) => JSON.parse(frame.data).payload;
  const until = async (reader: SseReader, done: (frame: SseFrame) => boolean) => {
    for (;;) {
      const frame = await reader.next();
      if (done(frame)) return frame;
    }
  };
  const settledState = (reader: SseReader, after: (state: { leafId: string | null }) => boolean) =>
    until(reader, (frame) => frame.event === "session.state" && after(payloadOf(frame)));
  const writeTurn = (path: string, content: string) =>
    toolCallTurn({
      type: "tool-call",
      callId: `w-${path}`,
      name: "write",
      arguments: { path, content },
    });

  async function checkpointed(provider: MockProvider) {
    const options = await hostOptions(provider);
    options.checkpointsGitDir = join(await tempDir(), "shadow");
    return options;
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

  function inferenceOver(providers: Readonly<Record<string, () => Provider>>): SessionInference {
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
      provider: (binding) =>
        providers[formatReference(binding.reference)]?.() ?? new MockProvider([]),
    };
  }

  it("stores the turn tag on the prompt entry, puts files back on undo, and brings them back on redo", async () => {
    const options = await checkpointed(
      new MockProvider([writeTurn("note.txt", "hello"), textTurn("wrote it")]),
    );
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call("/events"));
    await post(call, `/sessions/${id}/prompt`, { text: "write a note" });
    const settled = await settledState(reader, (state) => state.leafId !== null);
    expect(payloadOf(settled)).toMatchObject({ undoable: true, redoable: false });
    expect(await readFile(join(options.cwd, "note.txt"), "utf8")).toBe("hello");
    const { stores } = await scanSessions(options.sessionDir ?? "");
    const prompt = stores[0]
      ?.entries()
      .find((entry) => entry.type === "message" && entry.message.role === "user");
    expect(prompt?.type === "message" ? prompt.checkpoint : undefined).toMatch(/^[0-9a-f]{40,64}$/);

    const undone = await post(call, `/sessions/${id}/undo`);
    expect(undone.status).toBe(200);
    expect(await undone.json()).toEqual({
      prompt: { entryId: prompt?.id, text: "write a note" },
      filesNote: "files put back",
      undoable: true,
      redoable: true,
    });
    expect(existsSync(join(options.cwd, "note.txt"))).toBe(false);
    expect(
      ((await (await call(`/sessions/${id}`)).json()) as { messages: unknown[] }).messages,
    ).toEqual([]);

    const redone = await post(call, `/sessions/${id}/redo`);
    expect(await redone.json()).toEqual({ restored: true, undoable: true, redoable: false });
    expect(await readFile(join(options.cwd, "note.txt"), "utf8")).toBe("hello");
    const restored = (await (await call(`/sessions/${id}`)).json()) as { messages: Message[] };
    expect(restored.messages).toHaveLength(4);
    await reader.close();
    await server.close();
  });

  it("keeps the checkpoint-free behavior under --no-checkpoints", async () => {
    const options = await hostOptions(
      new MockProvider([writeTurn("kept.txt", "stays"), textTurn("wrote it")]),
    );
    options.checkpoints = "off";
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call("/events"));
    await post(call, `/sessions/${id}/prompt`, { text: "write" });
    await settledState(reader, (state) => state.leafId !== null);
    const { stores } = await scanSessions(options.sessionDir ?? "");
    const prompt = stores[0]?.entries().find((entry) => entry.type === "message");
    expect(prompt?.type === "message" ? prompt.checkpoint : "set").toBeUndefined();
    expect(await (await post(call, `/sessions/${id}/undo`)).json()).toMatchObject({
      prompt: { text: "write" },
      filesNote: "files untouched",
    });
    expect(await readFile(join(options.cwd, "kept.txt"), "utf8")).toBe("stays");
    await reader.close();
    await server.close();
  });

  it("answers a stored session's model, thinking and effort from its JSONL and binds the model through the registry", async () => {
    const options = await hostOptions(new MockProvider([textTurn("from the process model")], "m0"));
    options.inference = inferenceOver({
      "mock/m-stored": () => new MockProvider([textTurn("from the stored model")], "m-stored"),
      "mock/other": () => new MockProvider([], "other"),
    });
    const stored = await SessionStore.create(
      join(options.sessionDir ?? "", "1-0001-1.jsonl"),
      options.cwd,
    );
    await stored.append({ role: "user", parts: [{ type: "text", text: "earlier" }] });
    await stored.appendModelChange("mock", "m-stored");
    await stored.appendThinkingLevelChange("on");
    await stored.appendEffortChange("high");
    const { server, call } = serverOver(options);
    const id = stored.header.id;
    const summary = { model: "mock/m-stored", thinking: true, effort: "high" };
    expect(await (await call(`/sessions/${id}`)).json()).toMatchObject({ live: false, ...summary });
    const listed = (await (await call("/sessions")).json()) as { sessions: unknown[] };
    expect(listed.sessions[0]).toMatchObject(summary);

    const reader = sseReader(await call("/events"));
    await post(call, `/sessions/${id}/prompt`, { text: "again" });
    const completed = await until(reader, (frame) => frame.event === "turn.completed");
    expect(payloadOf(completed).message.parts).toEqual([
      { type: "text", text: "from the stored model" },
    ]);
    await settledState(reader, () => true);
    expect(await (await call(`/sessions/${id}`)).json()).toMatchObject({ live: true, ...summary });

    const switched = await post(call, `/sessions/${id}/model`, { reference: "mock/other" });
    expect(await switched.json()).toEqual({
      model: { provider: "mock", model: "other" },
      notice: "model → mock/other",
    });
    const unknown = await post(call, `/sessions/${id}/model`, { reference: "mock/none" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: "unknown-model" });
    expect(await (await post(call, `/sessions/${id}/effort`, { level: null })).json()).toEqual({
      effort: null,
    });
    await reader.close();
    await server.close();
    const reopened = await SessionStore.open(stored.file);
    expect(reopened.modelSelection()).toMatchObject({ provider: "mock", modelId: "other" });
    expect(reopened.effort()).toBe("default");
    const { stores } = await scanSessions(options.sessionDir ?? "");
    expect(stores).toHaveLength(1);
  });

  it("falls back to the process provider with a notice when the stored model does not resolve", async () => {
    const options = await hostOptions(new MockProvider([textTurn("fallback answer")], "m0"));
    options.inference = inferenceOver({});
    const notices: string[] = [];
    options.notice = (text) => notices.push(text);
    const stored = await SessionStore.create(
      join(options.sessionDir ?? "", "1-0001-1.jsonl"),
      options.cwd,
    );
    await stored.appendModelChange("gone", "model");
    const { server, call } = serverOver(options);
    const reader = sseReader(await call("/events"));
    await post(call, `/sessions/${stored.header.id}/prompt`, { text: "hi" });
    const completed = await until(reader, (frame) => frame.event === "turn.completed");
    expect(payloadOf(completed).message.parts[0].text).toBe("fallback answer");
    expect(notices[0]).toMatch(/asked for gone\/model .* using the server's model$/);
    expect(await (await call(`/sessions/${stored.header.id}`)).json()).toMatchObject({
      model: "mock/m0",
    });
    await reader.close();
    await server.close();
  });

  it("compacts a real store with a focus and continues over the summary", async () => {
    const options = await hostOptions(
      new MockProvider([
        textTurn("one"),
        textTurn("two"),
        textTurn("## Goal\nthe focused summary"),
      ]),
    );
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call("/events"));
    for (const text of ["first", "second"]) {
      await post(call, `/sessions/${id}/prompt`, { text });
      await until(reader, (frame) => frame.event === "turn.completed");
      await settledState(reader, () => true);
    }
    const compacted = await post(call, `/sessions/${id}/compact`, { focus: "the goal" });
    expect(compacted.status).toBe(200);
    const report = (await compacted.json()) as {
      compacted: { type: string; summary: string } | null;
      notices: string[];
    };
    expect(report.compacted).toMatchObject({ type: "compaction" });
    expect(report.compacted?.summary).toContain("the focused summary");
    expect(report.notices[0]).toMatch(/^compacted /);
    expect(payloadOf(await settledState(reader, () => true))).toMatchObject({ undoable: true });
    const detail = (await (await call(`/sessions/${id}`)).json()) as { messages: Message[] };
    expect(detail.messages).toHaveLength(4);
    expect(JSON.stringify(detail.messages[0])).toContain("the focused summary");
    await reader.close();
    await server.close();
  });

  it("exports to a file inside the workspace and refuses one outside it", async () => {
    const options = await hostOptions(new MockProvider([textTurn("exported")]));
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call("/events"));
    await post(call, `/sessions/${id}/prompt`, { text: "hello" });
    await settledState(reader, (state) => state.leafId !== null);
    await reader.close();
    const page = await post(call, `/sessions/${id}/export`, { scope: "tree" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("hello");
    const written = await post(call, `/sessions/${id}/export`, { out: "transcript.html" });
    expect(written.status).toBe(201);
    const { file } = (await written.json()) as { file: string };
    expect(file).toBe(join(options.cwd, "transcript.html"));
    expect(await readFile(file, "utf8")).toContain("exported");
    const escaped = await post(call, `/sessions/${id}/export`, { out: "../escape.html" });
    expect(escaped.status).toBe(403);
    await server.close();
  });

  it("pins a title set over the wire so the auto-titler leaves it alone", async () => {
    const options = await hostOptions(new MockProvider([]));
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    expect(await (await post(call, `/sessions/${id}/rename`, { title: "Pinned" })).json()).toEqual({
      title: "Pinned",
    });
    const attachment = await sessionPort(options.sessionDir ?? "", options.cwd).open(id);
    await attachment?.rename?.("suggested by the titler");
    const { stores } = await scanSessions(options.sessionDir ?? "");
    expect(stores[0]?.name()).toBe("Pinned");
    expect(stores[0]?.titlePinned()).toBe(true);
    const listed = (await (await call("/sessions")).json()) as {
      sessions: Array<{ title: string }>;
    };
    expect(listed.sessions[0]?.title).toBe("Pinned");
    await server.close();
  });

  it("switches the process preset and every live session journals gate.preset", async () => {
    const options = await hostOptions(new MockProvider([]));
    let active: ActivePreset = "standard";
    options.presets = {
      active: () => active,
      apply: async (name) => {
        active = name;
      },
    };
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call(`/events?session=${id}`));
    expect((await post(call, "/preset", { name: "open" })).status).toBe(409);
    expect(await (await post(call, "/preset", { name: "open", confirmed: true })).json()).toEqual({
      from: "standard",
      to: "open",
    });
    const heard = await reader.next();
    expect(heard.event).toBe("gate.preset");
    expect(JSON.parse(heard.data)).toMatchObject({
      sessionId: id,
      payload: { from: "standard", to: "open" },
    });
    await reader.close();
    await server.close();
  });
});

describe("the surface ports over a served workspace (K3)", () => {
  const fixtureServerPath = fileURLToPath(
    new URL("../../engine/src/testing/mcp-fixture-server.ts", import.meta.url),
  );
  interface SurfacedOptions {
    cwd?: string;
    userRoot?: string;
    projectTrusted?: boolean;
    mcp?: boolean;
    flavor?: string;
  }
  async function surfacedServer(overrides: SurfacedOptions = {}) {
    const options = await hostOptions(new MockProvider([]));
    const cwd = overrides.cwd ?? options.cwd;
    const userRoot = overrides.userRoot ?? (await tempDir());
    const projectTrusted = overrides.projectTrusted === true;
    const sessionDir = options.sessionDir ?? "";
    const composition = await composeWorkspace({
      cwd,
      projectTrusted,
      userRoot,
      checkpoints: "off",
      ...(overrides.mcp === true && {
        mcpServers: {
          fixture: {
            transport: "stdio" as const,
            command: process.execPath,
            args: [fixtureServerPath, "basic"],
          },
        },
      }),
    });
    const host: SessionHost = {
      ...fileSessionHost({ ...options, cwd, userRoot, projectTrusted }),
      ...surfacePorts({
        cwd,
        projectTrusted,
        userRoot,
        sessionDir,
        flavor: overrides.flavor,
        composition: () => Promise.resolve(composition),
        session: async (id) => {
          const store = await findSession(sessionDir, id);
          return store === undefined ? undefined : { store, busy: () => false };
        },
      }),
    };
    const server = createKeyworkServer({ token, host, log: options.log, version: "test" });
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
    const surfaceKinds = () =>
      options.log
        .since(0)
        .filter((envelope) => envelope.type === "surface.changed")
        .map((envelope) => [(envelope.payload as { kind: string }).kind, envelope.sessionId]);
    const close = async () => {
      await server.close();
      await composition.mcp?.stop();
      await composition.languagePort?.dispose();
    };
    return { cwd, userRoot, sessionDir, call, post, surfaceKinds, close };
  }
  const answer = async <Shape>(response: Response, status = 200): Promise<Shape> => {
    expect(response.status).toBe(status);
    return (await response.json()) as Shape;
  };
  async function declaredWorkspace(): Promise<string> {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "surfaced" }));
    return cwd;
  }

  it("runs the MCP fixture server through restart and toggle, announcing on /events", async () => {
    const world = await surfacedServer({ mcp: true });
    try {
      const deadline = Date.now() + 10_000;
      let servers: Array<{ name: string; state: string; toolCount: number; transport?: string }>;
      for (;;) {
        servers = (await answer<{ servers: typeof servers }>(await world.call("/mcp"))).servers;
        if (servers[0]?.state === "connected") break;
        if (Date.now() > deadline) throw new Error("the fixture server never connected");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(servers[0]).toMatchObject({ name: "fixture", toolCount: 2, transport: "stdio" });
      expect(await answer(await world.call("/mcp/fixture/tools"))).toEqual({
        tools: ["echo", "add"],
      });
      const off = await answer(await world.post("/mcp/fixture/enabled", { on: false }));
      expect(off).toMatchObject({ name: "fixture", enabled: false, state: "down", toolCount: 0 });
      expect(await answer(await world.call("/mcp/fixture/tools"))).toEqual({ tools: [] });
      const on = await answer(await world.post("/mcp/fixture/enabled", { on: true }));
      expect(on).toMatchObject({ enabled: true, state: "connected", toolCount: 2 });
      const restarted = await answer(await world.post("/mcp/fixture/restart"));
      expect(restarted).toMatchObject({ enabled: true, state: "connected", toolCount: 2 });
      expect((await world.post("/mcp/nope/restart")).status).toBe(404);
      const kinds = world.surfaceKinds();
      expect(kinds.length).toBeGreaterThanOrEqual(3);
      expect(new Set(kinds.map(([kind, sessionId]) => `${kind}:${sessionId}`))).toEqual(
        new Set(["mcp:"]),
      );
    } finally {
      await world.close();
    }
  });

  it("trusts and declares the served root, writing trust.json under the user root, and refuses a home or untrusted root", async () => {
    const world = await surfacedServer();
    try {
      const before = await answer<{ identity: string; readiness: string; trust: string }>(
        await world.call("/workspace"),
      );
      expect(before.identity).toBe(workspaceInfoOf(world.cwd).identity);
      expect(before).toMatchObject({ readiness: "undecided", trust: "undecided", declared: false });
      const grant = await answer(await world.post("/workspace/trust", { path: "C:/elsewhere" }));
      expect(grant).toEqual({
        trusted: true,
        root: world.cwd,
        vault: join(world.cwd, ".keywork", "memory"),
        reopens: true,
      });
      const trustFile = join(world.userRoot, ".keywork", "trust.json");
      const recorded = JSON.parse(await readFile(trustFile, "utf8")) as Record<string, boolean>;
      expect(Object.values(recorded)).toEqual([true]);
      expect(new TrustStore({ home: world.userRoot }).resolve(world.cwd)).toBe("trusted");
      expect(new TrustStore({ home: world.userRoot }).resolve("C:/elsewhere")).toBe("undecided");
      await stat(join(world.cwd, ".keywork", "workspace.json"));
      expect(await answer(await world.call("/workspace"))).toMatchObject({
        declared: true,
        trust: "trusted",
        readiness: "ready",
        name: basename(world.cwd),
      });
      expect(await answer(await world.post("/workspace/trust"))).toMatchObject({ reopens: true });
      expect(world.surfaceKinds()).toEqual([
        ["workspaces", ""],
        ["workspaces", ""],
      ]);
    } finally {
      await world.close();
    }

    const home = await surfacedServer({ cwd: emptyUserRoot, userRoot: emptyUserRoot });
    try {
      const refused = await home.post("/workspace/trust");
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain("every directory");
    } finally {
      await home.close();
    }

    const userRoot = await tempDir();
    const cwd = await tempDir();
    new TrustStore({ home: userRoot }).untrust(cwd);
    const untrusted = await surfacedServer({ cwd, userRoot });
    try {
      expect((await untrusted.post("/workspace/trust")).status).toBe(409);
      expect(await answer(await untrusted.call("/workspace"))).toMatchObject({
        readiness: "refused",
      });
    } finally {
      await untrusted.close();
    }
  });

  it("serves the tree and file slices confined to the composed tool scope", async () => {
    const world = await surfacedServer();
    try {
      await mkdir(join(world.cwd, "src"));
      await writeFile(join(world.cwd, ".gitignore"), "dist/\n");
      await mkdir(join(world.cwd, "dist"));
      await writeFile(join(world.cwd, "src", "index.ts"), "export {};\n");
      const listed = await answer<{ entries: Array<{ name: string; ignored: boolean }> }>(
        await world.call("/tree"),
      );
      expect(listed.entries.map((entry) => [entry.name, entry.ignored])).toEqual([
        ["dist", true],
        ["src", false],
      ]);
      expect(await answer(await world.call("/files?path=src/index.ts&from=7"))).toMatchObject({
        path: "src/index.ts",
        text: "{};\n",
        truncated: false,
      });
      expect((await world.call("/tree?path=..")).status).toBe(403);
      expect((await world.call(`/files?path=${encodeURIComponent(emptyUserRoot)}`)).status).toBe(
        403,
      );
    } finally {
      await world.close();
    }
  });

  it("creates arcs and bots on a trusted workspace and binds a stored session to them", async () => {
    const cwd = await declaredWorkspace();
    const world = await surfacedServer({ cwd, projectTrusted: true });
    try {
      expect(await answer(await world.call("/arcs"))).toEqual({ arcs: [], ordinals: {} });
      expect(await answer(await world.post("/arcs", { slug: "alpha" }), 201)).toMatchObject({
        slug: "alpha",
        status: "active",
      });
      expect((await world.post("/arcs", { slug: "alpha" })).status).toBe(409);
      const stored = await SessionStore.create(join(world.sessionDir, "1-0001-1.jsonl"), cwd);
      await stored.append({ role: "user", parts: [{ type: "text", text: "earlier question" }] });
      const id = stored.header.id;
      expect(await answer(await world.post(`/sessions/${id}/arc`, { slug: "alpha" }))).toEqual({
        arc: "alpha",
      });
      const arcs = await answer<{ arcs: Array<{ slug: string; sessions: number }> }>(
        await world.call("/arcs"),
      );
      expect(arcs.arcs).toEqual([expect.objectContaining({ slug: "alpha", sessions: 1 })]);
      const scribe = await answer(
        await world.post("/bots", { slug: "scribe", scope: "project", purpose: "writes docs" }),
        201,
      );
      expect(scribe).toMatchObject({
        name: "scribe",
        source: "project",
        description: "writes docs",
      });
      await stat(join(cwd, ".keywork", "bots", "scribe", "bot.md"));
      expect(await answer<{ bots: unknown[] }>(await world.call("/bots"))).toEqual({
        bots: [expect.objectContaining({ name: "scribe", sessions: 0 })],
      });
      expect(await answer(await world.post(`/sessions/${id}/bot`, { name: "scribe" }))).toEqual({
        arc: "alpha",
        bot: "scribe",
      });
      expect((await world.post(`/sessions/${id}/bot`, { name: "ghost" })).status).toBe(409);
      expect((await world.post("/sessions/nope/bot", { name: "scribe" })).status).toBe(404);
      const reread = await findSession(world.sessionDir, id);
      expect(reread?.binding()).toEqual({ arc: "alpha", bot: "scribe" });
      expect(await answer(await world.post("/arcs/alpha/abandon"))).toEqual({
        slug: "alpha",
        abandoned: true,
      });
      expect((await findSession(world.sessionDir, id))?.arcBinding()).toBeUndefined();
      expect(world.surfaceKinds().map(([kind]) => kind)).toContain("arcs");
      expect(world.surfaceKinds().map(([kind]) => kind)).toContain("bots");
    } finally {
      await world.close();
    }

    const untrusted = await surfacedServer({ cwd: await declaredWorkspace() });
    try {
      expect((await untrusted.call("/arcs")).status).toBe(403);
      expect((await untrusted.post("/bots", { slug: "scribe", scope: "project" })).status).toBe(
        403,
      );
    } finally {
      await untrusted.close();
    }
  });

  it("lists workspaces, creates a named one, focuses a dir, and remembers which opens next", async () => {
    const cwd = await declaredWorkspace();
    const world = await surfacedServer({ cwd });
    try {
      expect(await answer<{ workspaces: unknown[] }>(await world.call("/workspaces"))).toEqual({
        workspaces: [expect.objectContaining({ name: "surfaced", declared: true, current: true })],
      });
      expect(await answer(await world.post("/workspaces", { slug: "docs" }), 201)).toEqual({
        slug: "docs",
      });
      await stat(join(cwd, ".keywork", "workspaces", "docs", "workspace.json"));
      await mkdir(join(cwd, "packages", "docs"), { recursive: true });
      expect(
        await answer(await world.post("/workspaces/docs/focus", { dir: "packages/docs" })),
      ).toEqual({
        dir: "packages/docs",
      });
      expect((await world.post("/workspaces/docs/focus", { dir: "nowhere" })).status).toBe(409);
      const listed = await answer<{ workspaces: Array<{ slug?: string; focusDirs: string[] }> }>(
        await world.call("/workspaces"),
      );
      expect(listed.workspaces.map((choice) => [choice.slug, choice.focusDirs])).toEqual([
        [undefined, []],
        ["docs", ["packages/docs"]],
      ]);
      expect(
        await answer(await world.post("/workspaces/docs/unfocus", { dir: "packages/docs" })),
      ).toEqual({
        dir: "packages/docs",
      });
      expect(await answer(await world.post("/workspaces/use", { slug: "docs" }))).toEqual({
        slug: "docs",
        reopens: true,
      });
      expect(
        fileWorkspaceRecall(workspaceRecallFile(keyworkHome(world.userRoot))).recall(cwd),
      ).toBe("docs");
      expect((await world.post("/workspaces/use", { slug: "nope" })).status).toBe(409);
    } finally {
      await world.close();
    }
  });

  it("lists the flavor closet without the terminal-derived system flavor", async () => {
    const world = await surfacedServer({ flavor: "system" });
    try {
      const listed = await answer<{ flavors: Array<{ name: string }>; active: string }>(
        await world.call("/flavors"),
      );
      expect(listed.flavors.map((flavor) => flavor.name)).toEqual(["keywork-night"]);
      expect(listed.active).toBe("system");
    } finally {
      await world.close();
    }
  });
});
