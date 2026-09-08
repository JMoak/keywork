import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, MockProvider, SessionStore, textTurn, toolCallTurn } from "@keywork/engine";
import {
  createKeyworkServer,
  EventLog,
  readServerTicket,
  writeServerTicket,
} from "@keywork/server";
import { memorySessionHost, sseReader } from "@keywork/server/testing";
import { scratchDirs } from "@keywork/shared/testing";
import { afterAll, describe, expect, it } from "vitest";
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
