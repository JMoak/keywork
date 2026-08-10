import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { messageText, textMessage } from "../messages.ts";
import { SessionStore } from "./store.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-session-"));
  tempDirs.push(dir);
  return dir;
}

async function sessionFile(name = "session.jsonl"): Promise<string> {
  return join(await tempDir(), name);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionStore", () => {
  it("round-trips a conversation through disk", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, "C:\\repo");
    await store.append(textMessage("user", "hi"));
    await store.append(textMessage("assistant", "hello"));

    const reopened = await SessionStore.open(file);

    expect(reopened.header.cwd).toBe("C:\\repo");
    expect(reopened.messages()).toEqual([
      textMessage("user", "hi"),
      textMessage("assistant", "hello"),
    ]);
  });

  it("links entries into a parent chain with timestamps", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    const first = await store.append(textMessage("user", "one"));
    const second = await store.append(textMessage("assistant", "two"));

    expect(first.parentId).toBeNull();
    expect(second.parentId).toBe(first.id);
    expect(second.timestamp).not.toBe("");
  });

  it("survives a torn final line", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    await store.append(textMessage("user", "kept"));
    await appendFile(file, '{"type":"message","id":"torn', "utf8");

    const reopened = await SessionStore.open(file);

    expect(reopened.messages()).toEqual([textMessage("user", "kept")]);
  });

  it("rejects files without a session header", async () => {
    const file = await sessionFile();
    await appendFile(file, '{"type":"message","id":"x","parentId":null}\n', "utf8");

    await expect(SessionStore.open(file)).rejects.toThrow(/not a keywork session/);
  });

  it("migrates legacy headers written before format version 3", async () => {
    const file = await sessionFile();
    await writeFile(
      file,
      '{"type":"session","id":"old","cwd":".","createdAt":"2026-01-01T00:00:00.000Z"}\n{"type":"message","id":"m1","parentId":null,"message":{"role":"user","parts":[{"type":"text","text":"hi"}]}}\n',
      "utf8",
    );

    const store = await SessionStore.open(file);

    expect(store.header.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(store.header.version).toBe(1);
    expect(store.messages()).toEqual([textMessage("user", "hi")]);
  });

  it("forks from a mid-conversation entry and keeps both branches continuable", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    const root = await store.append(textMessage("user", "start"));
    await store.append(textMessage("assistant", "first branch"));

    store.branch(root.id);
    await store.append(textMessage("assistant", "second branch"));

    expect(store.messages().map(messageText)).toEqual(["start", "second branch"]);

    const reopened = await SessionStore.open(file);
    expect(reopened.messages().map(messageText)).toEqual(["start", "second branch"]);

    reopened.branch(root.id);
    await reopened.append(textMessage("assistant", "third branch"));
    expect(reopened.entries()).toHaveLength(4);
    expect(reopened.tree()[0]?.children).toHaveLength(3);
  });

  it("refuses to branch from an unknown entry", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    expect(() => store.branch("missing")).toThrow(/no session entry/);
  });

  it("labels round-trip and can anchor a fork", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    const target = await store.append(textMessage("user", "important point"));
    await store.append(textMessage("assistant", "later"));
    await store.setLabel(target.id, "checkpoint");

    const reopened = await SessionStore.open(file);
    expect(reopened.labelFor(target.id)).toBe("checkpoint");

    const labeled = reopened.entryForLabel("checkpoint");
    expect(labeled?.id).toBe(target.id);
    reopened.branch((labeled as { id: string }).id);
    await reopened.append(textMessage("assistant", "fork at label"));
    expect(reopened.messages().map(messageText)).toEqual(["important point", "fork at label"]);
  });

  it("clears a label with undefined", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    const target = await store.append(textMessage("user", "x"));
    await store.setLabel(target.id, "temp");
    await store.setLabel(target.id, undefined);

    expect(store.labelFor(target.id)).toBeUndefined();
    expect(store.labels().size).toBe(0);
  });

  it("persists a session name", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    await store.setName("refactor-session");

    expect((await SessionStore.open(file)).name()).toBe("refactor-session");
  });

  it("builds a tree with branch points, labels, and the active path", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    const root = await store.append(textMessage("user", "root"));
    const left = await store.append(textMessage("assistant", "left"));
    store.branch(root.id);
    const right = await store.append(textMessage("assistant", "right"));
    await store.setLabel(right.id, "winner");

    const [rootNode] = store.tree();
    expect(rootNode?.entry.id).toBe(root.id);
    expect(rootNode?.children.map((child) => child.entry.id)).toContain(left.id);
    const rightNode = rootNode?.children.find((child) => child.entry.id === right.id);
    expect(rightNode?.label).toBe("winner");
    expect(rightNode?.onActivePath).toBe(true);
    expect(rootNode?.children.find((child) => child.entry.id === left.id)?.onActivePath).toBe(
      false,
    );
  });

  it("clones the active path into a fresh session referencing its parent", async () => {
    const dir = await tempDir();
    const source = await SessionStore.create(join(dir, "source.jsonl"), ".");
    const root = await source.append(textMessage("user", "shared"));
    await source.append(textMessage("assistant", "kept in clone"));
    source.branch(root.id);
    await source.append(textMessage("assistant", "not in clone"));

    const clone = await source.clone(join(dir, "clone.jsonl"));

    expect(clone.header.parentSession).toBe(source.file);
    expect(clone.header.id).not.toBe(source.header.id);
    expect(clone.messages().map(messageText)).toEqual(["shared", "not in clone"]);

    await clone.append(textMessage("user", "clone continues"));
    await source.append(textMessage("user", "source continues"));
    expect((await SessionStore.open(clone.file)).messages().map(messageText)).toEqual([
      "shared",
      "not in clone",
      "clone continues",
    ]);
    expect((await SessionStore.open(source.file)).messages().map(messageText)).toEqual([
      "shared",
      "not in clone",
      "source continues",
    ]);
  });

  it("clones from an explicit entry point", async () => {
    const dir = await tempDir();
    const source = await SessionStore.create(join(dir, "source.jsonl"), ".");
    const first = await source.append(textMessage("user", "one"));
    await source.append(textMessage("assistant", "two"));

    const clone = await source.clone(join(dir, "clone.jsonl"), first.id);

    expect(clone.messages().map(messageText)).toEqual(["one"]);
  });

  it("serves compaction-aware messages: summary plus kept tail", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    await store.append(textMessage("user", "old question"));
    await store.append(textMessage("assistant", "old answer"));
    const kept = await store.append(textMessage("user", "recent question"));
    await store.append(textMessage("assistant", "recent answer"));
    await store.appendCompaction({
      summary: "## Goal\nsummarized",
      firstKeptEntryId: kept.id,
      tokensBefore: 1234,
    });

    expect(store.messages().map(messageText)).toEqual([
      "## Goal\nsummarized",
      "recent question",
      "recent answer",
    ]);
  });

  it("reports stats that match a known fixture exactly", async () => {
    const store = await SessionStore.create(
      await sessionFile(),
      ".",
      new Date("2026-08-10T10:00:00.000Z"),
    );
    const root = await store.append(textMessage("user", "q"));
    await store.append(textMessage("assistant", "a"), { inputTokens: 100, outputTokens: 20 });
    store.branch(root.id);
    await store.append(textMessage("assistant", "b"), { inputTokens: 110, outputTokens: 30 });
    await store.setLabel(root.id, "start");
    await store.appendCompaction({
      summary: "s",
      firstKeptEntryId: root.id,
      tokensBefore: 500,
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    const stats = store.stats();

    expect(stats).toEqual({
      entries: 5,
      messages: 3,
      userMessages: 1,
      branchPoints: 1,
      labels: 1,
      compactions: 1,
      usage: { inputTokens: 250, outputTokens: 60 },
      createdAt: "2026-08-10T10:00:00.000Z",
      lastActivityAt: stats.lastActivityAt,
    });
    expect(stats.lastActivityAt).not.toBe("");
  });
});
