import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArcRegistry,
  Checkpoints,
  MemoryInertError,
  MemoryStore,
  type Message,
  MockProvider,
  messageText,
  type Provider,
  type ProviderRequest,
  SessionStore,
  type TurnDelta,
  textMessage,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import {
  type BusEnvelope,
  createKeyworkServer,
  EventLog,
  maxFileSliceBytes,
  readServerTicket,
  type SessionEntries,
  writeServerTicket,
} from "@keywork/server";
import { inferenceOver, memorySessionHost, sseReader } from "@keywork/server/testing";
import {
  type ActivePreset,
  type CompleteTheme,
  canonicalPath,
  contrastFailures,
  gallery,
  type PresetName,
  resolveVaultPath,
  TrustStore,
} from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { afterAll, describe, expect, it } from "vitest";
import { keyworkHome } from "./paths.ts";
import {
  alreadyServingExit,
  fileSessionHost,
  type HostOptions,
  serve,
  serverTicketFile,
  ticketFilesFor,
  workspaceInfoOf,
  workspaceTicketFile,
} from "./serve.ts";
import { scanSessions } from "./sessions/store.ts";
import { fileWorkspaceRecall, workspaceRecallFile } from "./workspaces.ts";

const tempDir = scratchDirs("keywork-serve-");
const fixtureServerPath = fileURLToPath(
  new URL("../../engine/src/testing/mcp-fixture-server.ts", import.meta.url),
);
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
    checkpointsGitDir: await tempDir(),
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
    expect(await host.prompt("nope", "hi", "queue")).toBe("missing");
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

describe("fileSessionHost permission layers", () => {
  const bash = (callId: string, command: string) =>
    toolCallTurn({ type: "tool-call", callId, name: "bash", arguments: { command } });
  const printfRule = { action: "bash", resource: "printf *", effect: "allow" };
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  async function layeredOptions(provider: MockProvider, projectTrusted: boolean) {
    return { ...(await hostOptions(provider)), projectTrusted, permissions: () => undefined };
  }

  async function prompted(served: ReturnType<typeof serverOver>, id: string, text: string) {
    const reader = sseReader(await served.call("/events"));
    await served.call(`/sessions/${id}/prompt`, json({ text }));
    return {
      until: async (event: string) => {
        const frames: Array<{ event: string | undefined; data: string }> = [];
        for (;;) {
          const frame = await reader.next();
          frames.push(frame);
          if (frame.event === event) return frames;
        }
      },
      close: () => reader.close(),
    };
  }

  function decisionsIn(frames: ReadonlyArray<{ event: string | undefined; data: string }>) {
    return frames
      .filter((frame) => frame.event === "gate.permission")
      .map((frame) => JSON.parse(frame.data).payload.decision);
  }

  async function sessionOn(served: ReturnType<typeof serverOver>): Promise<string> {
    return ((await (await served.call("/sessions", { method: "POST" })).json()) as { id: string })
      .id;
  }

  it("runs a read-only command in a trusted workspace without an ask, and still asks for a compound", async () => {
    const options = await layeredOptions(
      new MockProvider([
        bash("c1", "echo trusted"),
        bash("c2", "echo a; printf b"),
        textTurn("done"),
      ]),
      true,
    );
    const served = serverOver(options);
    const id = await sessionOn(served);
    const turn = await prompted(served, id, "look");
    const beforeAsk = await turn.until("gate.ask");
    expect(beforeAsk.some((frame) => frame.event === "tool.output")).toBe(true);
    expect(decisionsIn(beforeAsk)).toEqual([
      { tool: "bash", callId: "c1", verdict: "granted", gate: "trusted" },
    ]);
    await served.call("/asks/c2", json({ verdict: "denied" }));
    await turn.until("turn.completed");
    await turn.close();
    await served.server.close();
  });

  it("keeps an untrusted workspace on the built-in posture", async () => {
    const options = await layeredOptions(
      new MockProvider([bash("c1", "echo plain"), textTurn("done")]),
      false,
    );
    const served = serverOver(options);
    const id = await sessionOn(served);
    const turn = await prompted(served, id, "look");
    const asked = await turn.until("gate.ask");
    expect(JSON.parse(asked.at(-1)?.data ?? "{}").payload.ask).toMatchObject({
      rule: "default",
      rules: [{ action: "bash", resource: "echo plain *", effect: "allow" }],
    });
    await served.call("/asks/c1", json({ verdict: "denied" }));
    await turn.until("turn.completed");
    await turn.close();
    expect(await (await served.call("/permissions")).json()).toMatchObject({
      trusted: false,
      bundle: [],
    });
    await served.server.close();
  });

  it("stops the second ask after a session grant", async () => {
    const options = await layeredOptions(
      new MockProvider([
        bash("c1", "printf %s one"),
        bash("c2", "printf %s two"),
        textTurn("done"),
      ]),
      false,
    );
    const served = serverOver(options);
    const id = await sessionOn(served);
    const turn = await prompted(served, id, "print");
    await turn.until("gate.ask");
    expect(
      (await served.call("/asks/c1", json({ verdict: "granted", scope: "session" }))).status,
    ).toBe(200);
    const frames = await turn.until("turn.completed");
    expect(frames.some((frame) => frame.event === "gate.ask")).toBe(false);
    expect(decisionsIn(frames)).toEqual([
      { tool: "bash", callId: "c1", verdict: "granted", gate: "user", scope: "session" },
      { tool: "bash", callId: "c2", verdict: "granted", gate: "user", scope: "session" },
    ]);
    expect(await (await served.call("/permissions")).json()).toMatchObject({
      workspace: [],
      session: { [id]: [printfRule] },
    });
    await turn.close();
    await served.server.close();
  });

  it("keeps a workspace grant across a reopen until it is revoked", async () => {
    const first = await layeredOptions(
      new MockProvider([bash("c1", "printf %s one"), textTurn("done")]),
      false,
    );
    const opened = serverOver(first);
    const firstTurn = await prompted(opened, await sessionOn(opened), "print");
    await firstTurn.until("gate.ask");
    await opened.call("/asks/c1", json({ verdict: "granted", scope: "workspace" }));
    await firstTurn.until("turn.completed");
    await firstTurn.close();
    await opened.server.close();

    const reopened = serverOver({
      ...(await layeredOptions(
        new MockProvider([
          bash("c2", "printf %s two"),
          textTurn("done"),
          bash("c3", "printf %s three"),
          textTurn("done"),
        ]),
        false,
      )),
      cwd: first.cwd,
    });
    expect(
      ((await (await reopened.call("/permissions")).json()) as { workspace: unknown[] }).workspace,
    ).toEqual([printfRule]);
    const id = await sessionOn(reopened);
    const granted = await prompted(reopened, id, "print again");
    const frames = await granted.until("turn.completed");
    expect(decisionsIn(frames)).toEqual([
      { tool: "bash", callId: "c2", verdict: "granted", gate: "user", scope: "workspace" },
    ]);
    await granted.close();

    const revoked = await reopened.call(
      "/permissions/workspace/revoke",
      json({ rule: printfRule }),
    );
    expect(revoked.status).toBe(200);
    const asking = await prompted(reopened, id, "print once more");
    const asked = await asking.until("gate.ask");
    expect(JSON.parse(asked.at(-1)?.data ?? "{}").payload.ask.callId).toBe("c3");
    await reopened.call("/asks/c3", json({ verdict: "denied" }));
    await asking.until("turn.completed");
    await asking.close();
    await reopened.server.close();
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
    expect(await host.prompt("nope", "hi", "queue")).toBe("missing");
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

describe("the tree over stored sessions", () => {
  async function branchedStore(options: HostOptions) {
    const store = await SessionStore.create(
      join(options.sessionDir ?? "", "1-0001-1.jsonl"),
      options.cwd,
    );
    const question = await store.append({
      role: "user",
      parts: [{ type: "text", text: "which way?" }],
    });
    const answer = await store.append({
      role: "assistant",
      parts: [{ type: "text", text: "left" }],
    });
    store.branch(question.id);
    const retry = await store.append({
      role: "user",
      parts: [{ type: "text", text: "try right" }],
    });
    await store.setLabel(answer.id, "went left");
    await store.appendCompaction({
      summary: "folded",
      firstKeptEntryId: retry.id,
      tokensBefore: 9,
    });
    await store.appendArcBinding("maps");
    await store.setName("directions");
    return { store, question, answer, retry };
  }

  it("round-trips a fork, a label, a compaction and a binding from the JSONL", async () => {
    const options = await hostOptions(new MockProvider([]));
    const { store, question, answer, retry } = await branchedStore(options);
    const { server, call } = serverOver(options);
    const tree = (await (
      await call(`/sessions/${store.header.id}/entries`)
    ).json()) as SessionEntries;
    expect(tree.sessionId).toBe(store.header.id);
    expect(tree.name).toBe("directions");
    expect(tree.entries.map((entry) => entry.type)).toEqual([
      "message",
      "message",
      "message",
      "label",
      "compaction",
      "binding",
      "session_info",
    ]);
    expect(tree.entries.map((entry) => entry.parentId).slice(0, 3)).toEqual([
      null,
      question.id,
      question.id,
    ]);
    expect(tree.labels).toEqual({ [answer.id]: "went left" });
    expect(tree.activePath.slice(0, 2)).toEqual([question.id, retry.id]);
    expect(tree.activePath).not.toContain(answer.id);
    expect(tree.leafId).toBe(tree.entries.at(-1)?.id);
    await server.close();
  });

  it("forks at an entry into a session on disk that names its parent, and labels and moves the leaf", async () => {
    const options = await hostOptions(new MockProvider([textTurn("right it is")]));
    const { store, question, answer } = await branchedStore(options);
    const { server, call } = serverOver(options);
    const post = (path: string, body: unknown) =>
      call(path, { method: "POST", body: JSON.stringify(body) });
    const forked = await post(`/sessions/${store.header.id}/fork`, { entryId: answer.id });
    expect(forked.status).toBe(201);
    const summary = (await forked.json()) as { id: string; title: string; messageCount: number };
    expect(summary).toMatchObject({ title: "which way?", messageCount: 2 });
    const listed = (await (await call("/sessions")).json()) as { sessions: Array<{ id: string }> };
    expect(listed.sessions.map((session) => session.id)).toContain(summary.id);
    const read = (await (await call(`/sessions/${summary.id}`)).json()) as { messages: Message[] };
    expect(read.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const { stores } = await scanSessions(options.sessionDir ?? "");
    expect(
      stores.find((candidate) => candidate.header.id === summary.id)?.header.parentSession,
    ).toBe(store.file);

    const labelled = await post(`/sessions/${store.header.id}/label`, {
      entryId: question.id,
      label: "the fork",
    });
    expect(await labelled.json()).toEqual({ entryId: question.id, label: "the fork" });
    const moved = await post(`/sessions/${store.header.id}/leaf`, { entryId: answer.id });
    expect(await moved.json()).toEqual({ leafId: answer.id });
    const afterMove = (await (await call(`/sessions/${store.header.id}`)).json()) as {
      messages: Message[];
    };
    expect(afterMove.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    const reasons = options.log
      .since(0)
      .filter((envelope: BusEnvelope) => envelope.type === "session.tree")
      .map((envelope: BusEnvelope) => (envelope.payload as { reason: string }).reason);
    expect(reasons).toEqual(["fork", "label", "leaf"]);
    const states = options.log
      .since(0)
      .filter((envelope: BusEnvelope) => envelope.type === "session.state")
      .map((envelope: BusEnvelope) => envelope.payload);
    expect(states).toEqual([expect.objectContaining({ leafId: answer.id })]);
    await server.close();
  });
});

describe("workspace, files and trust over the file host", () => {
  const bodyOf = async (response: Response) => (await response.json()) as Record<string, unknown>;

  async function workspaceOnDisk(): Promise<HostOptions & { log: EventLog }> {
    const options = await hostOptions(new MockProvider([]));
    const { cwd } = options;
    await mkdir(join(cwd, "src", "deep"), { recursive: true });
    await mkdir(join(cwd, "dist"), { recursive: true });
    await writeFile(join(cwd, ".gitignore"), "dist/\n*.log\n");
    await writeFile(join(cwd, "src", "a.ts"), "alpha beta\n");
    await writeFile(join(cwd, "src", "deep", "b.ts"), "beta");
    await writeFile(join(cwd, "src", "deep", ".gitignore"), "b.ts\n");
    await writeFile(join(cwd, "dist", "out.js"), "built");
    await writeFile(join(cwd, "trace.log"), "noise");
    await writeFile(join(cwd, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(cwd, "big"), "x".repeat(maxFileSliceBytes + 5));
    return options;
  }

  it("describes a launch-anchored workspace as /doc does, then lists a level with gitignore and hidden flags", async () => {
    const options = await workspaceOnDisk();
    const { server, call } = serverOver(options);
    const workspace = await bodyOf(await call("/workspace"));
    expect(workspace).toMatchObject({
      anchor: { root: workspaceInfoOf(options.cwd).anchor, source: "launch" },
      identity: workspaceInfoOf(options.cwd).identity,
      declared: false,
      contextDirs: [],
      focusDirs: [],
      trust: "undecided",
      readiness: "undecided",
    });
    expect(await bodyOf(await call("/tree"))).toEqual({
      path: "",
      entries: [
        { name: "dist", kind: "dir", ignored: true, hidden: false },
        { name: "src", kind: "dir", ignored: false, hidden: false },
        { name: ".gitignore", kind: "file", ignored: false, hidden: true },
        { name: "big", kind: "file", ignored: false, hidden: false },
        { name: "bin.dat", kind: "file", ignored: false, hidden: false },
        { name: "trace.log", kind: "file", ignored: true, hidden: false },
      ],
    });
    expect(await bodyOf(await call("/tree?path=dist"))).toEqual({
      path: "dist",
      entries: [{ name: "out.js", kind: "file", ignored: true, hidden: false }],
    });
    expect(await bodyOf(await call("/tree?path=src/deep"))).toEqual({
      path: "src/deep",
      entries: [
        { name: ".gitignore", kind: "file", ignored: false, hidden: true },
        { name: "b.ts", kind: "file", ignored: true, hidden: false },
      ],
    });
    expect((await call("/tree?path=nope")).status).toBe(404);
    expect((await call("/tree?path=src/a.ts")).status).toBe(404);
    await server.close();
  });

  it("applies the tool jail to /tree and /files: dot-dot, absolute paths outside, and junctions out", async () => {
    const options = await workspaceOnDisk();
    const outside = await tempDir();
    await writeFile(join(outside, "secret.txt"), "shh");
    const { server, call } = serverOver(options);
    const escapes = ["..", "../x", "src/../..", outside, join(outside, "secret.txt")];
    for (const path of escapes) {
      const tree = await call(`/tree?path=${encodeURIComponent(path)}`);
      expect(tree.status, path).toBe(403);
      expect((await bodyOf(tree)).error).toContain("escapes the project root");
      expect((await call(`/files?path=${encodeURIComponent(path)}`)).status, path).toBe(403);
    }
    const junction = join(options.cwd, "link");
    const linked = await symlink(outside, junction, "junction").then(
      () => true,
      () => false,
    );
    if (linked) {
      expect((await call("/tree?path=link")).status).toBe(403);
      expect((await call("/files?path=link/secret.txt")).status).toBe(403);
    }
    await server.close();
  });

  it("reads byte ranges from disk, caps a request at 1 MiB, and refuses NUL content and oversize files", async () => {
    const options = await workspaceOnDisk();
    const { server, call } = serverOver(options);
    expect(await bodyOf(await call("/files?path=src/a.ts&from=6&to=10"))).toEqual({
      path: "src/a.ts",
      bytes: 11,
      from: 6,
      to: 10,
      text: "beta",
      truncated: false,
      eof: false,
      encoding: "utf-8",
    });
    expect(await bodyOf(await call("/files?path=src/a.ts&from=6"))).toMatchObject({
      text: "beta\n",
      eof: true,
    });
    expect(await bodyOf(await call("/files?path=big"))).toMatchObject({
      to: maxFileSliceBytes,
      truncated: true,
      eof: false,
    });
    expect((await call("/files?path=bin.dat")).status).toBe(415);
    expect((await call("/files?path=src")).status).toBe(404);
    expect((await call("/files?path=nope.ts")).status).toBe(404);
    await server.close();
  });

  it("records trust through the store, answers reopens: true once, and fires surface.changed", async () => {
    const options = await hostOptions(new MockProvider([]));
    options.userRoot = await tempDir();
    const { server, call } = serverOver(options);
    const reader = sseReader(await call("/events"));
    const granted = await call("/workspace/trust", { method: "POST", body: "{}" });
    expect(granted.status).toBe(200);
    expect(await bodyOf(granted)).toEqual({
      trusted: true,
      root: workspaceInfoOf(options.cwd).anchor,
      reopens: true,
    });
    const frame = await reader.next();
    expect(frame.event).toBe("surface.changed");
    expect(JSON.parse(frame.data)).toMatchObject({ sessionId: "", payload: { kind: "workspace" } });
    await reader.close();

    const store = new TrustStore({ home: options.userRoot });
    expect(store.file).toBe(join(options.userRoot, ".keywork", "trust.json"));
    expect(store.resolve(options.cwd)).toBe("trusted");
    expect(JSON.parse(await readFile(store.file, "utf8"))).toEqual({
      [canonicalPath(options.cwd)]: true,
    });
    expect(await bodyOf(await call("/workspace"))).toMatchObject({
      trust: "trusted",
      readiness: "undeclared",
    });
    expect(await bodyOf(await call("/workspace/trust", { method: "POST" }))).toMatchObject({
      reopens: false,
    });
    await server.close();
  });

  it("refuses a body path, a home directory, and a root already marked untrusted", async () => {
    const options = await hostOptions(new MockProvider([]));
    options.userRoot = await tempDir();
    const store = new TrustStore({ home: options.userRoot });
    const { server, call } = serverOver({ ...options, trustStore: store });
    const pathed = await call("/workspace/trust", {
      method: "POST",
      body: JSON.stringify({ path: options.userRoot }),
    });
    expect(pathed.status).toBe(400);
    expect(store.resolve(options.cwd)).toBe("undecided");

    store.untrust(options.cwd);
    const refused = await call("/workspace/trust", { method: "POST", body: "{}" });
    expect(refused.status).toBe(409);
    expect((await bodyOf(refused)).error).toContain("keywork trust reverses that");
    await server.close();

    const home = serverOver({ ...options, cwd: options.userRoot, trustStore: store });
    const blanket = await home.call("/workspace/trust", { method: "POST", body: "{}" });
    expect(blanket.status).toBe(400);
    expect((await bodyOf(blanket)).error).toContain("refusing to record a trust decision");
    await home.server.close();
  });

  it("lists the whole gallery complete, names the configured theme, and leaves system to the client", async () => {
    const options = await hostOptions(new MockProvider([]));
    const { server, call } = serverOver({ ...options, theme: "system" });
    const themes = (await bodyOf(await call("/themes"))) as {
      themes: CompleteTheme[];
      active: string;
      placeholders: string[];
    };
    expect(themes.themes.map((theme) => theme.name)).toEqual(gallery.map((theme) => theme.name));
    for (const theme of themes.themes) {
      expect(contrastFailures(theme), theme.name).toEqual([]);
      expect(Object.keys(theme.terminal)).toHaveLength(16);
      expect(theme.syntax.keyword).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.diff.insertedLine).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.selection.background).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.cursor).toMatch(/^#[0-9a-f]{6}$/i);
    }
    const night = themes.themes.find((theme) => theme.name === "keywork-night");
    expect(night?.pair).toBe("keywork-day");
    expect(themes.active).toBe("system");
    expect(themes.placeholders).toEqual(["system"]);
    await server.close();
  });
});

describe("changes under the file host", () => {
  const writeTurn = (path: string, content: string, reply: string) =>
    new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: `w-${path}`,
        name: "write",
        arguments: { path, content },
      }),
      textTurn(reply),
    ]);

  it("announces changes.updated after a write and lists the file with turn provenance", async () => {
    const options = await hostOptions(writeTurn("notes.txt", "hello\n", "wrote it"));
    options.projectTrusted = true;
    await writeFile(join(options.cwd, "kept.txt"), "old\n", "utf8");
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call("/events"));
    await call(`/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "write" }),
    });
    for (;;) {
      const frame = await reader.next();
      if (frame.event !== "changes.updated") continue;
      expect(JSON.parse(frame.data).payload).toEqual({ sessionId: id, paths: ["notes.txt"] });
      break;
    }
    await reader.close();

    const listed = await call(`/sessions/${id}/changes`);
    expect(await listed.json()).toEqual({
      trusted: true,
      baseline: "session start",
      files: [{ path: "notes.txt", added: 1, deleted: 0, turn: 1 }],
    });
    const file = await call(`/sessions/${id}/changes/file?path=notes.txt`);
    expect(await file.json()).toEqual({
      trusted: true,
      path: "notes.txt",
      before: null,
      after: "hello\n",
      note: "new",
      truncated: false,
    });
    const untouched = await call(`/sessions/${id}/changes/file?path=kept.txt`);
    expect(await untouched.json()).toMatchObject({ before: "old\n", after: "old\n" });
    expect((await call(`/sessions/${id}/changes/file?path=../escape`)).status).toBe(400);
    await server.close();
  });

  it("answers trusted: false with no files for an untrusted workspace", async () => {
    const options = await hostOptions(new MockProvider([]));
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    expect(await (await call(`/sessions/${id}/changes`)).json()).toEqual({
      trusted: false,
      files: [],
    });
    expect((await call("/sessions/nope/changes")).status).toBe(404);
    await server.close();
  });
});

describe("status surfaces over the file host", () => {
  const bodyOf = async (response: Response) => (await response.json()) as Record<string, unknown>;
  const post = (call: ReturnType<typeof serverOver>["call"], path: string, body?: unknown) =>
    call(path, { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });

  async function trustedWorkspace(provider: MockProvider | Provider) {
    const options = await hostOptions(provider as MockProvider);
    options.userRoot = await tempDir();
    options.projectTrusted = true;
    await mkdir(join(options.cwd, ".keywork"), { recursive: true });
    await writeFile(
      join(options.cwd, ".keywork", "workspace.json"),
      JSON.stringify({ name: "k3" }),
    );
    new TrustStore({ home: options.userRoot }).trust(options.cwd);
    return options;
  }

  async function untilConnected(call: ReturnType<typeof serverOver>["call"]) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { servers } = (await bodyOf(await call("/mcp"))) as {
        servers: Array<{ name: string; state: string; toolCount: number }>;
      };
      if (servers[0]?.state === "connected") return servers[0];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the fixture server never connected");
  }

  it("runs the MCP fixture through status, toggle, restart and tools, with surface.changed on the stream", async () => {
    const options = await hostOptions(new MockProvider([]));
    options.mcpServers = {
      fixture: {
        transport: "stdio",
        command: process.execPath,
        args: [fixtureServerPath, "basic"],
      },
    };
    const { server, call } = serverOver(options);
    const reader = sseReader(await call("/events"));
    const connected = await untilConnected(call);
    expect(connected.name).toBe("fixture");
    expect(connected.toolCount).toBeGreaterThan(0);
    const toolsUp = (await bodyOf(await call("/mcp/fixture/tools"))) as { tools: string[] };
    expect(toolsUp.tools.length).toBe(connected.toolCount);

    const disabled = await post(call, "/mcp/fixture/enabled", { enabled: false });
    expect(await bodyOf(disabled)).toMatchObject({
      name: "fixture",
      enabled: false,
      state: "down",
    });
    expect(await bodyOf(await call("/mcp/fixture/tools"))).toEqual({ tools: [] });
    const restarted = await post(call, "/mcp/fixture/restart");
    expect(await bodyOf(restarted)).toMatchObject({ enabled: true, state: "connected" });
    const frames: string[] = [];
    while (!frames.includes("mcp")) {
      const frame = await reader.next();
      if (frame.event === "surface.changed") frames.push(JSON.parse(frame.data).payload.kind);
      expect(JSON.parse(frame.data).sessionId).toBe("");
    }
    await reader.close();
    expect((await post(call, "/mcp/nope/restart")).status).toBe(404);
    expect((await post(call, "/mcp/fixture/enabled", {})).status).toBe(400);
    await server.close();
  }, 20_000);

  it("answers 404 for every MCP verb when no server is configured", async () => {
    const options = await hostOptions(new MockProvider([]));
    const { server, call } = serverOver(options);
    expect(await bodyOf(await call("/mcp"))).toEqual({ servers: [] });
    expect((await post(call, "/mcp/fixture/restart")).status).toBe(404);
    expect((await call("/mcp/fixture/tools")).status).toBe(404);
    await server.close();
  });

  it("refuses arcs with the readiness notice in an untrusted workspace", async () => {
    const options = await hostOptions(new MockProvider([]));
    const { server, call } = serverOver(options);
    const listed = await call("/arcs");
    expect(listed.status).toBe(403);
    expect((await bodyOf(listed)).error).toContain("isn't trusted yet");
    expect((await post(call, "/arcs", { slug: "dock-v2" })).status).toBe(403);
    await server.close();
  });

  it("walks new, bind, close and abandon on real arcs, persisting the binding in the session file", async () => {
    const options = await trustedWorkspace(new MockProvider([]));
    const { server, call } = serverOver(options);
    const reader = sseReader(await call("/events"));
    expect(await bodyOf(await call("/arcs"))).toEqual({ arcs: [], ordinals: {} });
    const created = await post(call, "/arcs", { slug: "dock-v2" });
    expect(created.status).toBe(201);
    expect(await bodyOf(created)).toMatchObject({ slug: "dock-v2", status: "active", sessions: 0 });
    expect(JSON.parse((await reader.next()).data)).toMatchObject({
      sessionId: "",
      type: "surface.changed",
      payload: { kind: "arcs" },
    });
    expect(await bodyOf(await post(call, "/arcs", {}))).toMatchObject({ slug: "arc-2" });
    expect((await post(call, "/arcs", { slug: "dock-v2" })).status).toBe(409);
    expect((await post(call, "/arcs", { slug: "Bad Slug" })).status).toBe(400);

    const { id } = (await bodyOf(await post(call, "/sessions"))) as { id: string };
    expect(await bodyOf(await post(call, `/sessions/${id}/arc`, { slug: "dock-v2" }))).toEqual({
      sessionId: id,
      arc: "dock-v2",
    });
    expect(await bodyOf(await call(`/sessions/${id}`))).toMatchObject({ arc: "dock-v2" });
    const { stores } = await scanSessions(options.sessionDir ?? "");
    expect(stores[0]?.arcBinding()).toBe("dock-v2");
    const listed = (await bodyOf(await call("/arcs"))) as {
      arcs: Array<{ slug: string; sessions: number }>;
      ordinals: Record<string, number>;
    };
    expect(listed.arcs.find((arc) => arc.slug === "dock-v2")?.sessions).toBe(1);
    expect(listed.ordinals).toEqual({ "dock-v2": 0, "arc-2": 1 });
    expect((await post(call, `/sessions/${id}/arc`, { slug: "nope" })).status).toBe(404);

    const closed = await post(call, "/arcs/dock-v2/close", { direction: "wrap up" });
    expect(closed.status).toBe(200);
    expect(await bodyOf(closed)).toMatchObject({ kind: "closed", released: 1 });
    expect((await bodyOf(await call(`/sessions/${id}`))).arc).toBeUndefined();
    expect((await post(call, "/arcs/dock-v2/close")).status).toBe(409);
    expect((await post(call, "/arcs/nope/close")).status).toBe(404);
    expect(await bodyOf(await post(call, "/arcs/arc-2/abandon"))).toEqual({
      slug: "arc-2",
      abandoned: true,
    });
    const after = (await bodyOf(await call("/arcs"))) as { arcs: Array<{ status: string }> };
    expect(after.arcs.map((arc) => arc.status)).toEqual(["archived", "archived"]);
    await reader.close();
    await server.close();
  });

  it("defines a bot, switches a session onto it between turns, refuses mid-turn, and releases it", async () => {
    const options = await trustedWorkspace(hangingProvider());
    const { server, call } = serverOver(options);
    expect(await bodyOf(await call("/bots"))).toEqual({ bots: [] });
    const created = await post(call, "/bots", { slug: "scribe", scope: "user", purpose: "writes" });
    expect(created.status).toBe(201);
    expect(await bodyOf(created)).toMatchObject({
      name: "scribe",
      source: "user",
      description: "writes",
      learning: "notes",
    });
    expect((await post(call, "/bots", { slug: "scribe", scope: "project" })).status).toBe(409);
    expect((await post(call, "/bots", { slug: "Bad Slug", scope: "user" })).status).toBe(400);

    const { id } = (await bodyOf(await post(call, "/sessions"))) as { id: string };
    expect((await post(call, `/sessions/${id}/bot`, { slug: "nope" })).status).toBe(404);
    expect(await bodyOf(await post(call, `/sessions/${id}/bot`, { slug: "scribe" }))).toEqual({
      sessionId: id,
      bot: "scribe",
    });
    expect(await bodyOf(await call(`/sessions/${id}`))).toMatchObject({ bot: "scribe" });
    const { stores } = await scanSessions(options.sessionDir ?? "");
    expect(stores[0]?.botBinding()).toBe("scribe");
    const bots = (await bodyOf(await call("/bots"))) as { bots: Array<{ sessions: number }> };
    expect(bots.bots[0]?.sessions).toBe(1);

    const reader = sseReader(await call("/events"));
    await post(call, `/sessions/${id}/prompt`, { text: "wait" });
    while ((await reader.next()).event !== "turn.started");
    const busy = await post(call, `/sessions/${id}/bot`, { slug: null });
    expect(busy.status).toBe(409);
    await post(call, `/sessions/${id}/abort`);
    while ((await reader.next()).event !== "turn.interrupted");
    await reader.close();
    expect(await bodyOf(await post(call, `/sessions/${id}/bot`, { slug: null }))).toEqual({
      sessionId: id,
      bot: null,
    });
    await server.close();
  });

  it("refuses a project bot without trust", async () => {
    const options = await hostOptions(new MockProvider([]));
    const { server, call } = serverOver(options);
    const refused = await post(call, "/bots", { slug: "scribe", scope: "project" });
    expect(refused.status).toBe(403);
    expect((await bodyOf(refused)).error).toContain("project bots need a trusted workspace");
    await server.close();
  });

  it("lists, creates, uses, focuses and unfocuses named workspaces on disk", async () => {
    const options = await trustedWorkspace(new MockProvider([]));
    await mkdir(join(options.cwd, "packages", "api"), { recursive: true });
    const { server, call } = serverOver(options);
    const listed = (await bodyOf(await call("/workspaces"))) as { workspaces: unknown[] };
    expect(listed.workspaces).toEqual([
      expect.objectContaining({ name: "k3", declared: true, current: true, focusDirs: [] }),
    ]);
    const created = await post(call, "/workspaces", { slug: "api-v2" });
    expect(created.status).toBe(201);
    expect((await post(call, "/workspaces", { slug: "api-v2" })).status).toBe(409);
    expect((await post(call, "/workspaces", { slug: "Bad Slug" })).status).toBe(400);
    const after = (await bodyOf(await call("/workspaces"))) as {
      workspaces: Array<{ slug?: string; name: string }>;
    };
    expect(after.workspaces.map((choice) => choice.slug)).toEqual([undefined, "api-v2"]);
    expect(after.workspaces[1]?.name).toBe("api v2");

    expect(await bodyOf(await post(call, "/workspaces/use", { slug: "api-v2" }))).toEqual({
      slug: "api-v2",
      reopens: true,
    });
    const recall = fileWorkspaceRecall(workspaceRecallFile(keyworkHome(options.userRoot)));
    expect(recall.recall(options.cwd)).toBe("api-v2");
    expect(await bodyOf(await post(call, "/workspaces/use", { slug: null }))).toEqual({
      slug: null,
      reopens: true,
    });
    expect(recall.recall(options.cwd)).toBeUndefined();
    expect((await post(call, "/workspaces/use", { slug: "nope" })).status).toBe(404);

    const focused = await post(call, "/workspaces/api-v2/focus", { dir: "packages/api" });
    expect(await bodyOf(focused)).toEqual({ dir: "packages/api" });
    expect((await post(call, "/workspaces/api-v2/focus", { dir: "packages/api" })).status).toBe(
      400,
    );
    expect((await post(call, "/workspaces/api-v2/focus", { dir: "../elsewhere" })).status).toBe(
      400,
    );
    expect((await post(call, "/workspaces/nope/focus", { dir: "packages/api" })).status).toBe(404);
    const focusedList = (await bodyOf(await call("/workspaces"))) as {
      workspaces: Array<{ slug?: string; focusDirs: string[] }>;
    };
    expect(focusedList.workspaces[1]?.focusDirs).toEqual(["packages/api"]);
    expect(
      await bodyOf(await post(call, "/workspaces/default/focus", { dir: "packages/api" })),
    ).toEqual({
      dir: "packages/api",
    });
    expect(
      await bodyOf(await post(call, "/workspaces/api-v2/unfocus", { dir: "packages/api" })),
    ).toEqual({
      dir: "packages/api",
    });
    expect((await post(call, "/workspaces/api-v2/unfocus", { dir: "packages/api" })).status).toBe(
      400,
    );
    expect(
      options.log.since(0).filter((envelope) => envelope.type === "surface.changed"),
    ).not.toHaveLength(0);
    await server.close();
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

describe("memory over the file host", () => {
  async function trustedWorkspace(options: HostOptions): Promise<string> {
    await mkdir(join(options.cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(
      join(options.cwd, ".keywork", "workspace.json"),
      JSON.stringify({ name: "fixture" }),
    );
    options.projectTrusted = true;
    return resolveVaultPath(options.cwd) ?? "";
  }

  const jsonPost =
    (call: (path: string, init?: RequestInit) => Promise<Response>) =>
    (path: string, body: unknown = {}) =>
      call(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

  async function nextInboxEvent(reader: ReturnType<typeof sseReader>) {
    for (;;) {
      const frame = await reader.next();
      if (frame.event === "memory.inbox") return JSON.parse(frame.data) as BusEnvelope;
    }
  }

  it("answers inert on an untrusted workspace: empty reads, 403 writes", async () => {
    const options = await hostOptions(new MockProvider([]));
    const { server, call } = serverOver(options);
    expect(await (await call("/memory")).json()).toMatchObject({ trusted: false, layers: [] });
    const approve = await call("/memory/inbox/x/approve", { method: "POST" });
    expect(approve.status).toBe(403);
    expect(await approve.json()).toEqual({ error: new MemoryInertError().message });
    await server.close();
  });

  it("approves a note staged in the composed vault, lands it in the garden and fires memory.inbox", async () => {
    const options = await hostOptions(new MockProvider([]));
    const vaultRoot = await trustedWorkspace(options);
    const vault = new MemoryStore({ vaultRoot, trusted: true });
    await vault.writeNote({
      title: "Stray Claim",
      body: "Thirds, maybe.\n",
      provenance: "untrusted",
    });
    const { server, call } = serverOver(options);
    const inbox = (await (await call("/memory/inbox")).json()) as {
      trusted: boolean;
      count: number;
      items: Array<{ id: string; kind: string; target: string }>;
    };
    expect(inbox).toMatchObject({ trusted: true, count: 1 });
    expect(inbox.items[0]).toMatchObject({ kind: "note", target: "Stray Claim.md" });

    const reader = sseReader(await call("/events"));
    const approved = await call(`/memory/inbox/${inbox.items[0]?.id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    expect(await nextInboxEvent(reader)).toMatchObject({
      sessionId: "",
      payload: { count: 0, kinds: {} },
    });
    await reader.close();
    const note = await call("/memory/notes/Stray%20Claim");
    expect(await note.json()).toMatchObject({
      trusted: true,
      note: { name: "Stray Claim", provenance: "untrusted", layer: "workspace", curing: 0 },
    });
    expect((await vault.readNote("Stray Claim"))?.body).toBe("Thirds, maybe.\n");
    const ledger = (await (await call("/memory/ledger")).json()) as {
      entries: Array<{ op: string }>;
    };
    expect(ledger.entries.map((entry) => entry.op)).toEqual(["approve"]);
    await server.close();
  });

  it("walks the airlock over HTTP: finish stages the review for a bound session, triage carries a question, finish closes the arc", async () => {
    const options = await hostOptions(
      new MockProvider([textTurn("noted"), textTurn("flushed through serve")]),
    );
    const vaultRoot = await trustedWorkspace(options);
    const registry = new ArcRegistry({ vaultRoot, trusted: true });
    await registry.createArc("dock-v2");
    await registry.createArc("next-arc");
    await registry.arcStore("dock-v2").writeNote({
      title: "Dock Ratio Finding",
      body: "Docks split 50/50 by default.\n",
      provenance: "agent",
    });
    await registry
      .openQuestions("dock-v2")
      .add({ title: "Tie order", body: "Which pane wins a tie?", provenance: "user" });
    const stored = await SessionStore.create(
      join(options.sessionDir ?? "", "1-0001-1.jsonl"),
      options.cwd,
    );
    await stored.appendArcBinding("dock-v2");
    const { server, call } = serverOver(options);
    const post = jsonPost(call);
    const reader = sseReader(await call("/events"));
    await post(`/sessions/${stored.header.id}/prompt`, { text: "remember the docks" });
    while ((await reader.next()).event !== "turn.completed");
    expect(await nextInboxEvent(reader)).toMatchObject({
      sessionId: "",
      payload: { count: 0, kinds: {} },
    });

    expect((await call("/arcs/dock-v2/airlock")).status).toBe(404);
    expect((await post("/arcs/nowhere/airlock/finish")).status).toBe(404);
    const undecided = await post("/arcs/dock-v2/airlock/finish");
    expect(await undecided.json()).toEqual({ kind: "undecided", items: ["Tie order"] });
    expect((await nextInboxEvent(reader)).payload).toEqual({
      count: 2,
      kinds: { "arc-distillation": 1, "arc-question": 1 },
    });

    const digest = (await (await call("/arcs/dock-v2/airlock")).json()) as { digest: unknown };
    expect(digest.digest).toMatchObject({
      arc: "dock-v2",
      sweep: { acked: 1, wedged: 0 },
      candidates: [
        { note: "Dock Ratio Finding", eligible: false, shortfalls: ["uncited"], choice: "leave" },
      ],
      questions: [{ title: "Tie order", provenance: "user" }],
    });
    const garden = (await (await call("/memory")).json()) as {
      layers: Array<{ id: string }>;
      airlocks: Array<{ arc: string }>;
    };
    expect(garden.layers.map((layer) => layer.id)).toEqual([
      "workspace",
      "arc:dock-v2",
      "arc:next-arc",
    ]);
    expect(garden.airlocks.map((waiting) => waiting.arc)).toEqual(["dock-v2"]);

    const carried = await post("/arcs/dock-v2/airlock/questions", {
      title: "Tie order",
      choice: "carry",
    });
    expect(await carried.json()).toMatchObject({
      successor: "next-arc",
      questions: [{ title: "Tie order", choice: "carry" }],
    });
    const closed = await post("/arcs/dock-v2/airlock/finish", { force: true });
    expect(await closed.json()).toEqual({ kind: "closed", delivered: 0, released: 1 });
    expect((await nextInboxEvent(reader)).payload).toEqual({ count: 0, kinds: {} });
    await reader.close();

    expect((await call("/arcs/dock-v2/airlock")).status).toBe(404);
    expect((await registry.openQuestions("next-arc").open()).map((q) => q.title)).toEqual([
      "Tie order",
    ]);
    expect((await registry.readArc("dock-v2"))?.status).toBe("archived");
    const after = (await (await call("/memory")).json()) as { layers: Array<{ id: string }> };
    expect(after.layers.map((layer) => layer.id)).toEqual(["workspace", "arc:next-arc"]);
    await server.close();
    const { stores } = await scanSessions(options.sessionDir ?? "");
    expect(stores[0]?.arcBinding()).toBeUndefined();
  });
});

describe("K0 · checkpoints and per-session inference under serve", () => {
  const writingTurns = (content: string, callId: string) => [
    toolCallTurn({
      type: "tool-call",
      callId,
      name: "write",
      arguments: { path: "note.txt", content },
    }),
    textTurn(`wrote ${content}`),
  ];

  it("captures a checkpoint before a mutating tool and tags the user message with it", async () => {
    const options = await hostOptions(new MockProvider(writingTurns("v1", "c1")));
    const { server, host, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call("/events"));
    await call(`/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "write v1" }),
    });
    while ((await reader.next()).event !== "turn.completed");
    await reader.close();
    expect(await readFile(join(options.cwd, "note.txt"), "utf8")).toBe("v1");
    const checkpoints = await host.checkpointsOf(id);
    expect(checkpoints).toBeInstanceOf(Checkpoints);
    expect((checkpoints as Checkpoints).canUndo()).toBe(true);
    expect(await host.checkpointsOf("nope")).toBe("missing");
    await server.close();

    const { stores } = await scanSessions(options.sessionDir ?? "");
    const prompt = stores[0]?.entries().find((entry) => entry.type === "message");
    expect(prompt?.type === "message" && prompt.checkpoint).toMatch(/^[0-9a-f]{40,}$/);
  });

  it("keeps today's behavior with checkpoints off: no tag, nothing to undo", async () => {
    const options = {
      ...(await hostOptions(new MockProvider(writingTurns("v1", "c1")))),
      checkpoints: "off" as const,
    };
    const { server, host, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call("/events"));
    await call(`/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "write v1" }),
    });
    while ((await reader.next()).event !== "turn.completed");
    await reader.close();
    expect(await host.checkpointsOf(id)).toBe("off");
    expect((await call(`/sessions/${id}/undo`, { method: "POST" })).status).toBe(200);
    expect(await host.undo(id)).toBe("staged");
    await server.close();
    const { stores } = await scanSessions(options.sessionDir ?? "");
    const prompt = stores[0]?.entries().find((entry) => entry.type === "message");
    expect(prompt?.type === "message" && prompt.checkpoint).toBeUndefined();
  });

  it("builds each session from its own model, thinking and effort entries", async () => {
    const seen: ProviderRequest[] = [];
    const alpha = new MockProvider([textTurn("from alpha")], "alpha");
    const beta: Provider = {
      name: "mock",
      modelId: "beta",
      stream: (request) => {
        seen.push(request);
        return new MockProvider([textTurn("from beta")]).stream(request);
      },
    };
    const options = {
      ...(await hostOptions(alpha)),
      inference: inferenceOver({ "mock/alpha": alpha, "mock/beta": beta }),
    };
    const stored = await SessionStore.create(
      join(options.sessionDir ?? "", "1-0001-1.jsonl"),
      options.cwd,
    );
    await stored.append(textMessage("user", "earlier"));
    await stored.appendModelChange("mock", "beta");
    await stored.appendThinkingLevelChange("on");
    await stored.appendEffortChange("high");
    const { server, call } = serverOver(options);
    const listed = (await (await call("/sessions")).json()) as { sessions: unknown[] };
    expect(listed.sessions[0]).toMatchObject({
      model: "mock/beta",
      thinking: true,
      effort: "high",
    });

    const reader = sseReader(await call("/events"));
    await call(`/sessions/${stored.header.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "which model?" }),
    });
    while ((await reader.next()).event !== "turn.completed");
    await reader.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ thinking: true, effort: "high" });
    const live = (await (await call(`/sessions/${stored.header.id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(live).toMatchObject({ live: true, model: "mock/beta", thinking: true, effort: "high" });
    expect(alpha.remaining()).toBe(1);
    await server.close();
  });
});

describe("K1 · session verbs over the file host", () => {
  const post = (call: ReturnType<typeof serverOver>["call"], path: string, body?: unknown) =>
    call(path, { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });
  const completed = async (reader: ReturnType<typeof sseReader>) => {
    while ((await reader.next()).event !== "turn.completed");
  };
  const nextFrame = async (reader: ReturnType<typeof sseReader>, event: string) => {
    for (;;) {
      const frame = await reader.next();
      if (frame.event === event) return frame;
    }
  };
  const writing = (content: string, callId: string) => [
    toolCallTurn({
      type: "tool-call",
      callId,
      name: "write",
      arguments: { path: "note.txt", content },
    }),
    textTurn(`wrote ${content}`),
  ];

  it("undo hands the prompt back and restores the files; redo brings the turn and the files back", async () => {
    const options = await hostOptions(
      new MockProvider([...writing("v1", "c1"), ...writing("v2", "c2")]),
    );
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call("/events"));
    for (const text of ["write v1", "write v2"]) {
      await post(call, `/sessions/${id}/prompt`, { text });
      await completed(reader);
    }
    const note = () => readFile(join(options.cwd, "note.txt"), "utf8");
    expect(await note()).toBe("v2");

    const undone = await post(call, `/sessions/${id}/undo`);
    expect(undone.status).toBe(200);
    const result = (await undone.json()) as {
      prompt: { entryId: string; text: string };
      filesNote: string;
    };
    expect(result).toMatchObject({
      prompt: { text: "write v2" },
      filesNote: "files put back",
      redoable: true,
    });
    expect(await note()).toBe("v1");
    const state = JSON.parse((await nextFrame(reader, "session.state")).data) as {
      type: string;
      payload: { leafId: string; redoable: boolean };
    };
    expect(state.type).toBe("session.state");
    expect(state.payload.redoable).toBe(true);
    const rewound = (await (await call(`/sessions/${id}`)).json()) as { messages: Message[] };
    expect(rewound.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect((await post(call, `/sessions/${id}/undo`)).status).toBe(409);

    const redone = await post(call, `/sessions/${id}/redo`);
    expect(await redone.json()).toEqual({ restored: true, undoable: true, redoable: false });
    expect(await note()).toBe("v2");
    const restored = (await (await call(`/sessions/${id}`)).json()) as { messages: Message[] };
    expect(restored.messages).toHaveLength(8);
    expect((await post(call, `/sessions/${id}/redo`)).status).toBe(404);
    await reader.close();
    await server.close();

    const { stores } = await scanSessions(options.sessionDir ?? "");
    expect(stores[0]?.messages()).toHaveLength(8);
  });

  it("switches the model and records thinking and effort as session entries", async () => {
    const alpha = new MockProvider([], "alpha");
    const beta = new MockProvider([textTurn("from beta")], "beta");
    const options = {
      ...(await hostOptions(alpha)),
      inference: inferenceOver({ "mock/alpha": alpha, "mock/beta": beta }),
    };
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    expect(
      await (await post(call, `/sessions/${id}/model`, { reference: "mock/beta" })).json(),
    ).toEqual({
      model: { provider: "mock", model: "beta" },
      notice: "model → mock/beta",
    });
    expect((await post(call, `/sessions/${id}/model`, { reference: "gamma" })).status).toBe(400);
    expect(await (await post(call, `/sessions/${id}/thinking`, { on: true })).json()).toEqual({
      thinking: true,
    });
    expect(await (await post(call, `/sessions/${id}/effort`, { level: "xhigh" })).json()).toEqual({
      effort: "xhigh",
    });
    expect(await (await post(call, `/sessions/${id}/effort`, { level: null })).json()).toEqual({
      effort: null,
    });
    const reader = sseReader(await call("/events"));
    await post(call, `/sessions/${id}/prompt`, { text: "hello" });
    await completed(reader);
    await reader.close();
    expect(beta.remaining()).toBe(0);
    await server.close();

    const { stores } = await scanSessions(options.sessionDir ?? "");
    const types = stores[0]?.entries().map((entry) => entry.type) ?? [];
    expect(types.slice(0, 4)).toEqual([
      "model_change",
      "thinking_level_change",
      "effort_change",
      "effort_change",
    ]);
    expect(stores[0]?.modelSelection()).toMatchObject({ provider: "mock", modelId: "beta" });
    expect(stores[0]?.thinkingLevel()).toBe("on");
    expect(stores[0]?.effort()).toBe("default");
  });

  it("compacts on request with a focus and rebuilds the live history over the summary", async () => {
    const provider = new MockProvider([textTurn("## Goal\nthe summary")], {
      modelId: "small",
      capabilities: { input: ["text"], toolCalls: true, contextWindow: 500 },
    });
    const options = await hostOptions(provider);
    const stored = await SessionStore.create(
      join(options.sessionDir ?? "", "1-0001-1.jsonl"),
      options.cwd,
    );
    for (let turn = 1; turn <= 6; turn += 1) {
      await stored.append(textMessage("user", `question ${turn} ${"q".repeat(200)}`));
      await stored.append(textMessage("assistant", `answer ${turn} ${"a".repeat(200)}`));
    }
    const { server, call } = serverOver(options);
    const compacted = await post(call, `/sessions/${stored.header.id}/compact`, {
      focus: "the goal",
    });
    expect(compacted.status).toBe(200);
    const outcome = (await compacted.json()) as {
      compacted: { summary: string } | null;
      notices: string[];
    };
    expect(outcome.compacted?.summary).toContain("the summary");
    expect(outcome.notices[0]).toMatch(/^compacted /);
    const live = (await (await call(`/sessions/${stored.header.id}`)).json()) as {
      messages: Message[];
    };
    expect(messageText(live.messages[0] as Message)).toContain("the summary");
    expect(live.messages.length).toBeLessThan(12);

    const fresh = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    expect(await (await post(call, `/sessions/${fresh.id}/compact`, {})).json()).toEqual({
      compacted: null,
      notices: ["nothing to compact yet · the recent turns are all that's here"],
    });
    await server.close();
  });

  it("exports as HTML in the body or to a file inside the workspace, and refuses to escape it", async () => {
    const options = await hostOptions(new MockProvider([textTurn("an answer")]));
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call("/events"));
    await post(call, `/sessions/${id}/prompt`, { text: "a question" });
    await completed(reader);
    await reader.close();
    await post(call, `/sessions/${id}/rename`, { title: "Exported" });

    const inline = await post(call, `/sessions/${id}/export`, {});
    expect(inline.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await inline.text();
    expect(html).toContain("<title>Exported</title>");
    expect(html).toContain("a question");
    await mkdir(join(options.cwd, "exports"));
    const written = await post(call, `/sessions/${id}/export`, { scope: "tree", out: "exports" });
    expect(written.status).toBe(201);
    const { file } = (await written.json()) as { file: string };
    expect(file.startsWith(join(options.cwd, "exports"))).toBe(true);
    expect(file.endsWith(".tree.html")).toBe(true);
    expect(await readFile(file, "utf8")).toContain("a question");
    const escaped = await post(call, `/sessions/${id}/export`, { out: "../outside.html" });
    expect(escaped.status).toBe(403);
    await server.close();
  });

  it("renames the session durably and reads context and cost", async () => {
    const provider = new MockProvider(
      [textTurn("sure", { inputTokens: 50, outputTokens: 5 })],
      "gpt-5",
    );
    const options = await hostOptions(provider);
    const { server, call } = serverOver(options);
    const { id } = (await (await call("/sessions", { method: "POST" })).json()) as { id: string };
    const reader = sseReader(await call(`/events?session=${id}`));
    expect(await (await post(call, `/sessions/${id}/rename`, { title: "Lights" })).json()).toEqual({
      title: "Lights",
    });
    expect(JSON.parse((await reader.next()).data)).toMatchObject({
      type: "session.state",
      sessionId: id,
      payload: { title: "Lights", thinking: false, undoable: false, redoable: false },
    });
    await post(call, `/sessions/${id}/prompt`, { text: "hello" });
    await completed(reader);
    await reader.close();
    const context = (await (await call(`/sessions/${id}/context`)).json()) as {
      used: number;
      basis: string;
    };
    expect(context.used).toBeGreaterThan(0);
    expect(context.basis).toBe("estimated");
    const cost = (await (await call(`/sessions/${id}/cost`)).json()) as {
      usage: { inputTokens: number };
      basis: string;
    };
    expect(cost.usage.inputTokens).toBe(50);
    expect(cost.basis).toBe("estimated from gpt-5 rates");
    await server.close();

    const { stores } = await scanSessions(options.sessionDir ?? "");
    expect(stores[0]?.name()).toBe("Lights");
  });

  it("switches the process preset through the preset port and announces gate.preset", async () => {
    let active: ActivePreset = "standard";
    const applied: string[] = [];
    const options = {
      ...(await hostOptions(new MockProvider([]))),
      presets: {
        active: () => active,
        apply: async (name: PresetName) => {
          applied.push(name);
          active = name;
        },
      },
    };
    const { server, call } = serverOver(options);
    const reader = sseReader(await call("/events"));
    expect((await post(call, "/preset", { name: "open" })).status).toBe(409);
    expect(await (await post(call, "/preset", { name: "open", confirmed: true })).json()).toEqual({
      from: "standard",
      to: "open",
    });
    expect(applied).toEqual(["open"]);
    expect(JSON.parse((await reader.next()).data)).toMatchObject({
      type: "gate.preset",
      sessionId: "",
      payload: { from: "standard", to: "open" },
    });
    await reader.close();
    await server.close();

    const bare = serverOver(await hostOptions(new MockProvider([])));
    const unavailable = await post(bare.call, "/preset", { name: "careful" });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({ error: "this process has no preset switch" });
    await bare.server.close();
  });
});

describe("spills over the file host", () => {
  it("spills a live session's oversized tool output and serves it by id, live and once stored", async () => {
    const options = await hostOptions(
      new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "c1",
          name: "read",
          arguments: { path: "wide.txt" },
        }),
        textTurn("read it"),
      ]),
    );
    const wide = Array.from(
      { length: 1500 },
      (_, index) => `${String(index).padStart(4, "0")} ${"w".repeat(60)}`,
    ).join("\n");
    await writeFile(join(options.cwd, "wide.txt"), wide);
    const live = serverOver(options);
    const { id } = (await (await live.call("/sessions", { method: "POST" })).json()) as {
      id: string;
    };
    const reader = sseReader(await live.call("/events"));
    await live.call(`/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "read wide.txt" }),
    });
    while ((await reader.next()).event !== "turn.completed");
    await reader.close();
    const { messages } = (await (await live.call(`/sessions/${id}`)).json()) as {
      messages: Message[];
    };
    const spill = spilledReference(messages);
    const range = `?from=${spill.elidedFrom}&to=${spill.elidedTo}`;
    const elided = await live.call(`/sessions/${id}/spills/${spill.id}${range}`);
    expect(elided.status).toBe(200);
    const slice = (await elided.json()) as { text: string };
    expect(slice).toMatchObject({
      spillId: spill.id,
      bytes: spill.bytes,
      from: spill.elidedFrom,
      to: spill.elidedTo,
      truncated: false,
    });
    expect(slice.text).toContain("w".repeat(60));
    await live.server.close();

    const stored = serverOver(options);
    const reopened = await stored.call(`/sessions/${id}/spills/${spill.id}${range}`);
    expect(await reopened.json()).toEqual(slice);
    expect((await stored.call(`/sessions/${id}/spills/no-such-spill`)).status).toBe(404);
    expect((await stored.call(`/sessions/nope/spills/${spill.id}`)).status).toBe(404);
    await stored.server.close();
  });

  function spilledReference(messages: readonly Message[]) {
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "tool-result" && part.spill !== undefined) return part.spill;
      }
    }
    throw new Error("the read did not spill");
  }
});
