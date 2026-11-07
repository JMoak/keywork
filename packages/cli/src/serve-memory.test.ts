import { existsSync } from "node:fs";
import { join } from "node:path";
import { MockProvider, parseMemorySource, rememberFrom } from "@keywork/engine";
import { createKeyworkServer, EventLog } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { workspaceMemoryAccess } from "./memory.ts";
import { servedHost } from "./serve.ts";
import { servedMemory, stagedInbox } from "./serve-memory.ts";

const tempDir = scratchDirs("keywork-serve-memory-");
const token = "memory-token";

describe("memory under keywork serve in a workspace nobody ran init in", () => {
  it("is live when the workspace is trusted: empty lists, and no vault until something is written", async () => {
    const memory = await servedMemoryOf(true);
    try {
      expect(await memory.read("/memory/inbox")).toEqual({ trusted: true, items: [], count: 0 });
      expect(await memory.read("/memory/notes")).toMatchObject({ trusted: true, notes: [] });
      expect(await memory.read("/memory")).toMatchObject({ trusted: true, inbox: [] });
      expect(existsSync(join(memory.cwd, ".keywork", "memory"))).toBe(false);
    } finally {
      await memory.close();
    }
  });

  it("stays inert, and says untrusted, when the workspace is not trusted", async () => {
    const memory = await servedMemoryOf(false);
    try {
      expect(await memory.read("/memory/inbox")).toMatchObject({ trusted: false, items: [] });
      expect(await memory.read("/memory/notes")).toMatchObject({ trusted: false, notes: [] });
    } finally {
      await memory.close();
    }
  });
});

describe("a note a creature's message staged outside the routes", () => {
  it("fires memory.inbox, carries its addressee, and forgets and restores by its source", async () => {
    const memory = await stagingServed();
    try {
      await memory.read("/memory/inbox");
      await memory.stage();
      await settle();
      expect(memory.inboxCounts()).toEqual([1]);
      expect(await memory.read("/memory/inbox")).toMatchObject({
        trusted: true,
        count: 1,
        items: [{ kind: "note", source: "creature:wren", for: "creature:cob" }],
      });

      const { plan } = (await memory.post("/memory/forget/preview", {
        source: "creature:wren",
      })) as { plan: { digest: string; counts: object; staged: object[] } };
      expect(plan.counts).toMatchObject({ notes: 0, staged: 1 });
      expect(plan.staged).toEqual([
        expect.objectContaining({ for: "creature:cob", firstLine: "The five largest docs" }),
      ]);

      const { forgot } = (await memory.post("/memory/forget/apply", {
        source: "creature:wren",
        digest: plan.digest,
      })) as { forgot: { ledgerId: string } };
      expect(await memory.read("/memory/inbox")).toMatchObject({ count: 0 });
      await memory.post(`/memory/ledger/${forgot.ledgerId}/revert`, {});
      expect(await memory.read("/memory/inbox")).toMatchObject({ count: 1 });
      expect(memory.inboxCounts().slice(0, 3)).toEqual([1, 0, 1]);
    } finally {
      await memory.close();
    }
  });

  it("mirrors the staged inbox for a creature's next turn", async () => {
    const memory = await stagingServed();
    try {
      const staged = stagedInbox(memory.access);
      expect(staged()).toEqual([]);
      await memory.stage();
      await settle();
      expect(staged()).toEqual([expect.objectContaining({ for: "creature:cob" })]);
    } finally {
      await memory.close();
    }
  });
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function stagingServed() {
  const cwd = await tempDir();
  const log = new EventLog();
  const access = workspaceMemoryAccess(cwd, true);
  const host = await servedHost({
    cwd,
    sessionDir: await tempDir(),
    userRoot: await tempDir(),
    projectTrusted: true,
    provider: new MockProvider([]),
    permissions: () => "allow",
    checkpoints: "off",
    log,
  });
  const server = createKeyworkServer({
    token,
    host: { ...host, memory: servedMemory({ memory: access }) },
    log,
    version: "test",
  });
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await server.fetch(
      new Request(`http://keywork.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  const stage = async (): Promise<void> => {
    const store = access()?.store;
    if (store === undefined) throw new Error("no memory");
    await rememberFrom(store, parseMemorySource("creature:wren"), {
      title: "message from wren K3GImfYB",
      body: "The five largest docs\nare listed in notes/largest.md\n",
      self: "cob",
    });
  };
  const inboxCounts = (): number[] =>
    log
      .since(0)
      .filter((envelope) => envelope.type === "memory.inbox")
      .map((envelope) => (envelope.payload as { count: number }).count);
  return {
    access,
    stage,
    inboxCounts,
    read: (path: string) => call("GET", path),
    post: (path: string, body: unknown) => call("POST", path, body),
    close: () => server.close(),
  };
}

async function servedMemoryOf(projectTrusted: boolean) {
  const cwd = await tempDir();
  const log = new EventLog();
  const host = await servedHost({
    cwd,
    sessionDir: await tempDir(),
    userRoot: await tempDir(),
    projectTrusted,
    provider: new MockProvider([]),
    permissions: () => "allow",
    checkpoints: "off",
    log,
  });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const read = async (path: string): Promise<unknown> => {
    const response = await server.fetch(
      new Request(`http://keywork.test${path}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  return { cwd, read, close: () => server.close() };
}
