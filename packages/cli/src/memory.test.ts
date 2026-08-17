import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryFlush,
  MockProvider,
  ReviewItemNotFoundError,
  SessionStore,
  textMessage,
  textTurn,
} from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import {
  flushAfterTurn,
  memoryPanePort,
  memoryRecall,
  openWorkspaceMemory,
  retrievalDisclosure,
  sweepOnClose,
  withMemoryPrompt,
} from "./memory.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-cli-memory-"));
  tempDirs.push(dir);
  return dir;
}

async function declaredWorkspace(): Promise<string> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "fixture" }));
  return cwd;
}

describe("openWorkspaceMemory", () => {
  it("is absent without a workspace declaration", async () => {
    expect(openWorkspaceMemory(await tempDir(), true)).toBeUndefined();
  });

  it("opens the vault at .keywork/memory for a declared workspace", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, true);
    expect(memory).toBeDefined();
    await memory?.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "user" });
    const raw = await readFile(join(cwd, ".keywork", "memory", "Ratio Rule.md"), "utf8");
    expect(raw).toContain("60/40");
  });
});

describe("memoryPanePort", () => {
  async function populatedMemory(trusted = true) {
    const cwd = await declaredWorkspace();
    const seed = openWorkspaceMemory(cwd, true);
    if (seed === undefined) throw new Error("expected a workspace memory");
    await seed.store.writeNote({ title: "User Fact", body: "typed by hand\n", provenance: "user" });
    await seed.store.writeNote({ title: "Fresh Guess", body: "inferred\n", provenance: "agent" });
    await seed.store.writeNote({
      title: "Proven Rule",
      body: "recalled often\n",
      provenance: "agent",
      usefulness: 0.6,
    });
    await seed.store.writeNote({
      title: "Web Claim",
      body: "from a fetched page\n",
      provenance: "untrusted",
    });
    const [review] = await seed.inbox.add([
      {
        kind: "contradiction",
        a: "User Fact",
        b: "Fresh Guess",
        aProvenance: "user",
        bProvenance: "agent",
        confidence: 0.7,
      },
    ]);
    const memory = trusted ? seed : openWorkspaceMemory(cwd, false);
    if (memory === undefined || review === undefined) throw new Error("fixture setup failed");
    return { memory, seed, reviewId: review.id };
  }

  it("maps notes, staged writes, and review items into pane inputs", async () => {
    const { memory, seed } = await populatedMemory();
    const inputs = await memoryPanePort(memory).load();
    expect(inputs.scopes).toEqual(["workspace"]);
    const curing = new Map(inputs.notes.map((note) => [note.title, note.curing]));
    expect(curing.get("User Fact")).toBe(3);
    expect(curing.get("Fresh Guess")).toBe(1);
    expect(curing.get("Proven Rule")).toBe(3);
    const staged = inputs.inbox.filter((item) => item.kind === "staged");
    const [stagedItem] = await seed.store.listStaged();
    expect(staged).toEqual([
      {
        id: `staged:${stagedItem?.id}`,
        kind: "staged",
        title: "Web Claim.md",
        provenance: "untrusted",
        created: stagedItem?.created,
        detail: "note",
      },
    ]);
    const contradiction = inputs.inbox.find((item) => item.kind === "contradiction");
    expect(contradiction?.title).toBe("User Fact vs Fresh Guess");
    expect(contradiction?.provenance).toBe("agent");
  });

  it("routes approve to the store for staged items and to the inbox for reviews", async () => {
    const { memory, seed, reviewId } = await populatedMemory();
    const port = memoryPanePort(memory);
    const [stagedItem] = await seed.store.listStaged();
    await port.approve(`staged:${stagedItem?.id}`);
    expect((await seed.store.listNotes()).map((note) => note.title)).toContain("Web Claim");
    await port.approve(`review:${reviewId}`);
    expect(await seed.inbox.list()).toEqual([]);
  });

  it("discard drops a staged item without landing it", async () => {
    const { memory, seed } = await populatedMemory();
    const [stagedItem] = await seed.store.listStaged();
    await memoryPanePort(memory).discard(`staged:${stagedItem?.id}`);
    expect(await seed.store.listStaged()).toEqual([]);
    expect((await seed.store.listNotes()).map((note) => note.title)).not.toContain("Web Claim");
  });

  it("approving an already-resolved review item raises the calm typed error", async () => {
    const { memory, reviewId } = await populatedMemory();
    const port = memoryPanePort(memory);
    await port.approve(`review:${reviewId}`);
    await expect(port.approve(`review:${reviewId}`)).rejects.toBeInstanceOf(
      ReviewItemNotFoundError,
    );
  });

  it("an untrusted vault loads as calm emptiness, never content", async () => {
    const { memory } = await populatedMemory(false);
    expect(await memoryPanePort(memory).load()).toEqual({
      scopes: [],
      notes: [],
      inbox: [],
      recalls: [],
    });
  });
});

describe("memoryRecall", () => {
  it("feeds recalls into the gardener under the session id", async () => {
    const memory = openWorkspaceMemory(await declaredWorkspace(), true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    const recall = memoryRecall(memory, "session-1");
    recall?.onRecall?.("Ratio Rule");
    const report = await memory.gardener.sweep();
    expect(report.usefulness["Ratio Rule"]).toBeGreaterThan(0);
  });

  it("records nothing while the session id is still unknown", async () => {
    const memory = openWorkspaceMemory(await declaredWorkspace(), true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    expect(memoryRecall(undefined)).toBeUndefined();
    memoryRecall(memory)?.onRecall?.("Ratio Rule");
    const report = await memory.gardener.sweep();
    expect(report.usefulness["Ratio Rule"] ?? 0).toBe(0);
  });

  it("resolves a late-bound session key at recall time", async () => {
    const memory = openWorkspaceMemory(await declaredWorkspace(), true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    let sessionId: string | undefined;
    const recall = memoryRecall(memory, () => sessionId);
    recall?.onRecall?.("Ratio Rule");
    sessionId = "sess-late";
    recall?.onRecall?.("Ratio Rule");
    const report = await memory.gardener.sweep();
    expect(report.usefulness["Ratio Rule"]).toBeGreaterThan(0);
  });

  it("stays silent about retrieval for lexical-only search", async () => {
    const memory = openWorkspaceMemory(await declaredWorkspace(), true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    const disclosures: string[] = [];
    const recall = memoryRecall(memory, "sess-1", (line) => disclosures.push(line));
    await recall?.search.search("ratio");
    expect(disclosures).toEqual([]);
  });

  it("discloses the embedding source on every hybrid search", async () => {
    const memory = openWorkspaceMemory(await declaredWorkspace(), true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    memory.embeddings = { id: "fake-embed", embed: async (texts) => texts.map(() => [1, 0]) };
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    const disclosures: string[] = [];
    const recall = memoryRecall(memory, "sess-1", (line) => disclosures.push(line));
    await recall?.search.search("ratio");
    expect(disclosures).toEqual(["memory search uses embeddings from fake-embed"]);
  });

  it("discloses degradation when the embedding source fails", async () => {
    const memory = openWorkspaceMemory(await declaredWorkspace(), true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    memory.embeddings = {
      id: "fake-embed",
      embed: async () => {
        throw new Error("socket reset");
      },
    };
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    const disclosures: string[] = [];
    const recall = memoryRecall(memory, "sess-1", (line) => disclosures.push(line));
    await recall?.search.search("ratio");
    expect(disclosures).toEqual([
      "memory search fell back to lexical, embeddings from fake-embed aren't available",
    ]);
  });
});

describe("retrievalDisclosure", () => {
  it("names the source for hybrid, degraded for fallback, nothing for lexical", () => {
    expect(retrievalDisclosure({ kind: "lexical" })).toBeUndefined();
    expect(retrievalDisclosure({ kind: "hybrid", embeddings: "voyage-3" })).toBe(
      "memory search uses embeddings from voyage-3",
    );
    expect(
      retrievalDisclosure({ kind: "lexical-degraded", embeddings: "voyage-3", reason: "down" }),
    ).toBe("memory search fell back to lexical, embeddings from voyage-3 aren't available");
  });
});

describe("withMemoryPrompt", () => {
  it("appends the injection only when there is one", () => {
    expect(withMemoryPrompt("base", "")).toBe("base");
    expect(withMemoryPrompt("base", "# Memory\n\nnotes")).toBe("base\n\n# Memory\n\nnotes");
  });
});

describe("flushAfterTurn", () => {
  async function sessionWith(messages: number): Promise<SessionStore> {
    const store = await SessionStore.create(join(await tempDir(), "session.jsonl"), ".");
    for (let index = 0; index < messages; index += 1) {
      await store.append(textMessage(index % 2 === 0 ? "user" : "assistant", `turn ${index}`));
    }
    return store;
  }

  it("persists the flush turn to the session JSONL when the threshold trips", async () => {
    const memory = openWorkspaceMemory(await declaredWorkspace(), true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    const session = await sessionWith(4);
    const flush = new MemoryFlush({
      provider: new MockProvider([textTurn("tests run on Node, not Bun")]),
      store: memory.store,
    });
    const flushed = await flushAfterTurn(flush, session, session.messages(), 100);
    expect(flushed).toHaveLength(2);
    expect(session.messages()).toHaveLength(6);
    expect((await memory.store.readDaily()).map((entry) => entry.text)).toEqual([
      "tests run on Node, not Bun",
    ]);
  });

  it("stays calm when the provider fails mid-flush: nothing persisted, session continues", async () => {
    const memory = openWorkspaceMemory(await declaredWorkspace(), true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    const session = await sessionWith(4);
    const flush = new MemoryFlush({
      provider: {
        name: "failing",
        stream: () => {
          throw new Error("socket reset");
        },
      },
      store: memory.store,
    });
    const flushed = await flushAfterTurn(flush, session, session.messages(), 100);
    expect(flushed).toEqual([]);
    expect(session.messages()).toHaveLength(4);
    expect(await memory.store.readDaily()).toEqual([]);
  });

  it("does nothing below the threshold or without a flush", async () => {
    const session = await sessionWith(2);
    expect(await flushAfterTurn(undefined, session, session.messages())).toEqual([]);
  });
});

describe("sweepOnClose", () => {
  it("leaves an audit entry on a trusted vault and swallows nothing-to-do", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    await sweepOnClose(memory);
    const audit = await readFile(join(cwd, ".keywork", "memory", "curation.md"), "utf8");
    expect(audit).toContain("gardener sweep");
  });

  it("is silent over an untrusted vault and without memory at all", async () => {
    const memory = openWorkspaceMemory(await declaredWorkspace(), false);
    await expect(sweepOnClose(memory)).resolves.toBeUndefined();
    await expect(sweepOnClose(undefined)).resolves.toBeUndefined();
  });
});

describe("ask-gate preferences at close", () => {
  it("proposes a preference through the inbox after repeated approvals", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, true);
    if (memory === undefined) throw new Error("memory expected");
    for (const _ of [1, 2, 3]) await memory.askGate.record("bash git", "yes");

    await sweepOnClose(memory);

    const items = await memory.inbox.list();
    expect(items.filter((item) => item.kind === "preference-proposal")).toHaveLength(1);
  });

  it("stays inert for an untrusted workspace", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, false);
    if (memory === undefined) throw new Error("memory expected");
    for (const _ of [1, 2, 3]) await memory.askGate.record("bash git", "yes");

    await sweepOnClose(memory);

    expect(await memory.inbox.list()).toHaveLength(0);
  });
});

describe("ask-gate persistence", () => {
  it("never writes ask events into an untrusted clone", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, false);
    if (memory === undefined) throw new Error("memory expected");
    await memory.askGate.record("bash git", "yes");

    await expect(
      readFile(join(cwd, ".keywork", "memory", ".staging", "ask-gate.json")),
    ).rejects.toThrow();
  });
});
