import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type EngineEvents,
  EventBus,
  knownCostNanos,
  SessionStore,
  textMessage,
} from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { boundSessionCounts, sessionChangeFeed, sessionPort, sessionTreePort } from "./ports.ts";
import {
  findSession,
  latestSessionFile,
  listSessions,
  newSessionFileName,
  openOrResumeSession,
} from "./store.ts";

const tempDir = scratchDirs("keywork-sessions-ports-");

async function storeOf(dir: string, id: string | undefined): Promise<SessionStore> {
  const store = await findSession(dir, id ?? "");
  if (store === undefined) throw new Error(`no session ${id}`);
  return store;
}

describe("sessionPort", () => {
  it("tags persisted user turns with the pending checkpoint tree", async () => {
    const dir = await tempDir();
    const tags = ["tree-one", "tree-two"];
    const port = sessionPort(dir, ".", { checkpointTag: () => tags.shift() });
    const attachment = await port.create();

    await attachment?.append(textMessage("user", "mutating turn"));
    await attachment?.append(textMessage("assistant", "done"));
    await attachment?.append(textMessage("user", "another mutating turn"));
    await attachment?.append(textMessage("user", "read-only turn"));

    const entries = (await storeOf(dir, attachment?.id)).entries();
    expect(entries[0]).toMatchObject({ checkpoint: "tree-one" });
    expect(entries[1]).not.toHaveProperty("checkpoint");
    expect(entries[2]).toMatchObject({ checkpoint: "tree-two" });
    expect(entries[3]).not.toHaveProperty("checkpoint");
  });

  it("persists untagged turns when no checkpoint source is wired", async () => {
    const dir = await tempDir();
    const port = sessionPort(dir, ".");
    const attachment = await port.create();

    await attachment?.append(textMessage("user", "prompt"));

    expect((await storeOf(dir, attachment?.id)).entries()[0]).not.toHaveProperty("checkpoint");
  });

  it("a created session never written to leaves no file on disk", async () => {
    const dir = await tempDir();
    const port = sessionPort(dir, ".");

    const attachment = await port.create();

    expect(attachment).toBeDefined();
    expect(await readdir(dir)).toEqual([]);
    expect((await listSessions(dir)).sessions).toEqual([]);
  });

  it("opens nothing for an unknown id and looks past unreadable files", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "0000000000001-0001-1.jsonl"), "{}\n", "utf8");
    const port = sessionPort(dir, ".");

    expect(await port.open("missing")).toBeUndefined();
  });

  it("surfaces a session directory that cannot be read", async () => {
    const unlistable = `${await tempDir()}\0`;

    await expect(sessionPort(unlistable, ".").open("any")).rejects.toThrow();
  });

  it("reports attach, change, and release through the seams", async () => {
    const dir = await tempDir();
    const attached: string[] = [];
    const changed: string[] = [];
    const released: string[] = [];
    const port = sessionPort(dir, ".", {
      onAttach: (store) => attached.push(store.header.id),
      onChange: (sessionId) => changed.push(sessionId),
      onRelease: (sessionId) => released.push(sessionId),
    });

    const attachment = await port.create();
    expect(attached).toEqual([attachment?.id]);

    await attachment?.append(textMessage("user", "hello"));
    await attachment?.append(textMessage("assistant", "hi"));
    expect(changed).toEqual([attachment?.id, attachment?.id]);

    port.release?.(attachment?.id ?? "");
    expect(released).toEqual([attachment?.id]);
  });

  it("persists a rename and serves it back as the attachment name", async () => {
    const dir = await tempDir();
    const changed: string[] = [];
    const port = sessionPort(dir, ".", { onChange: (sessionId) => changed.push(sessionId) });
    const created = await port.create();
    await created?.append(textMessage("user", "hello"));
    expect(created?.name).toBeUndefined();

    await created?.rename?.("tidy-title");
    expect(changed).toContain(created?.id);

    const reopened = await port.open(created?.id ?? "");
    expect(reopened?.name).toBe("tidy-title");
    expect((await listSessions(dir)).sessions[0]?.title).toBe("tidy-title");
  });

  it("persists the thinking switch once per change and serves it back on the attachment", async () => {
    const dir = await tempDir();
    const changed: string[] = [];
    const port = sessionPort(dir, ".", { onChange: (sessionId) => changed.push(sessionId) });
    const created = await port.create();
    expect(created?.thinking).toBeUndefined();

    await created?.recordThinking?.("on");
    await created?.recordThinking?.("on");
    await created?.recordThinking?.("off");
    expect(changed).toEqual([created?.id, created?.id]);

    const reopened = await port.open(created?.id ?? "");
    expect(reopened?.thinking).toBe("off");
    const levels = (await storeOf(dir, created?.id))
      .entries()
      .filter((entry) => entry.type === "thinking_level_change")
      .map((entry) => (entry as { thinkingLevel: string }).thinkingLevel);
    expect(levels).toEqual(["on", "off"]);
  });

  it("persists an arc binding as an entry and serves it back on the attachment and the overview", async () => {
    const dir = await tempDir();
    const bound: Array<[string, string | undefined]> = [];
    const port = sessionPort(dir, ".", { onArcBound: (id, arc) => bound.push([id, arc]) });
    const created = await port.create();
    await created?.append(textMessage("user", "hello"));
    expect(created?.arc).toBeUndefined();

    await created?.bindArc?.("dock-v2");
    await created?.bindArc?.("dock-v2");
    expect(bound).toEqual([[created?.id, "dock-v2"]]);
    expect(created?.arc).toBe("dock-v2");

    const reopened = await port.open(created?.id ?? "");
    expect(reopened?.arc).toBe("dock-v2");
    const items = await sessionTreePort(dir).overview?.();
    expect(items?.[0]?.arc).toBe("dock-v2");
    expect(await boundSessionCounts(dir)).toEqual(new Map([["dock-v2", 1]]));

    await reopened?.bindArc?.(undefined);
    expect(bound.at(-1)).toEqual([created?.id, undefined]);
    expect((await port.open(created?.id ?? ""))?.arc).toBeUndefined();
    expect(await boundSessionCounts(dir)).toEqual(new Map());
  });

  it("attaches reopened sessions through the same seam", async () => {
    const dir = await tempDir();
    const attached: string[] = [];
    const port = sessionPort(dir, ".", { onAttach: (store) => attached.push(store.header.id) });
    const created = await port.create();
    await created?.append(textMessage("user", "persist me"));

    const reopened = await port.open(created?.id ?? "");

    expect(reopened?.id).toBe(created?.id);
    expect(attached).toEqual([created?.id, created?.id]);
  });
});

describe("sessionChangeFeed", () => {
  it("pushes label and fork changes to tree-port subscribers", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    const first = await opened.store.append(textMessage("user", "root"));
    const feed = sessionChangeFeed();
    const port = sessionTreePort(dir, feed);
    const id = opened.store.header.id;
    const seen: string[] = [];
    const unsubscribe = port.subscribe?.((sessionId) => seen.push(sessionId));

    await port.setLabel(id, first.id, "start");
    await port.fork(id, first.id);
    expect(seen).toEqual([id, id]);

    unsubscribe?.();
    await port.setLabel(id, first.id, "again");
    expect(seen).toEqual([id, id]);
  });

  it("relays attachment appends emitted through the port seam", async () => {
    const dir = await tempDir();
    const feed = sessionChangeFeed();
    const seen: string[] = [];
    feed.subscribe((sessionId) => seen.push(sessionId));
    const port = sessionPort(dir, ".", { onChange: (sessionId) => feed.emit(sessionId) });

    const attachment = await port.create();
    await attachment?.append(textMessage("user", "typed"));

    expect(seen).toEqual([attachment?.id]);
  });
});

describe("sessionTreePort", () => {
  it("loads the tree, relabels, and forks through the disk store", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    const first = await opened.store.append(textMessage("user", "root question"));
    await opened.store.append(textMessage("assistant", "root answer"));
    const port = sessionTreePort(dir);
    const id = opened.store.header.id;

    const view = await port.load(id.slice(0, 8));
    expect(view?.sessionId).toBe(id);
    expect(view?.roots.at(0)?.entry.id).toBe(first.id);

    await port.setLabel(id, first.id, "start");
    const relabeled = await port.load(id);
    expect(relabeled?.roots.at(0)?.label).toBe("start");

    const forkedId = await port.fork(id, first.id);
    expect(forkedId).toBeDefined();
    expect(forkedId).not.toBe(id);
    const { sessions } = await listSessions(dir);
    expect(sessions.map((session) => session.id)).toContain(forkedId);
  });

  it("degrades cleanly on unknown sessions", async () => {
    const port = sessionTreePort(await tempDir());

    expect(await port.load("missing")).toBeUndefined();
    expect(await port.fork("missing", "entry")).toBeUndefined();
    await expect(port.setLabel("missing", "entry", "x")).rejects.toThrow("no session matches");
  });

  it("lists the overview most-recent-first with titles and counts", async () => {
    const dir = await tempDir();
    const older = await openOrResumeSession(dir, ".");
    const root = await older.store.append(textMessage("user", "plan the fix"));
    await older.store.append(textMessage("assistant", "on it"));
    await older.store.setLabel(root.id, "keep");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await openOrResumeSession(dir, ".");
    await newer.store.setName("release notes");
    await newer.store.append(textMessage("user", "draft the notes"));
    const port = sessionTreePort(dir);

    const overview = await port.overview?.();

    expect(overview?.map((item) => item.id)).toEqual([
      newer.store.header.id,
      older.store.header.id,
    ]);
    expect(overview?.map((item) => item.title)).toEqual(["release notes", "plan the fix"]);
    const olderItem = overview?.at(1);
    expect(olderItem?.entryCount).toBe(3);
    expect(olderItem?.branchCount).toBe(0);
    expect(olderItem?.labelCount).toBe(1);
    expect(olderItem?.modifiedAt).toBeLessThanOrEqual(overview?.at(0)?.modifiedAt ?? 0);
  });

  it("keeps header-only and unreadable session files out of the overview", async () => {
    const dir = await tempDir();
    const used = await openOrResumeSession(dir, ".");
    await used.store.append(textMessage("user", "hello"));
    const headerLine = (await readFile(used.store.file, "utf8")).split("\n")[0] ?? "";
    const phantomHeader = headerLine.replace(
      used.store.header.id,
      "00000000-aaaa-bbbb-cccc-000000000000",
    );
    await writeFile(join(dir, newSessionFileName()), `${phantomHeader}\n`);
    await writeFile(join(dir, newSessionFileName()), "not json at all\n");
    const port = sessionTreePort(dir);

    const overview = await port.overview?.();

    expect(overview?.map((item) => item.id)).toEqual([used.store.header.id]);
  });

  it("a fork shows up in the overview immediately", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    const root = await opened.store.append(textMessage("user", "root"));
    const port = sessionTreePort(dir);

    const forkedId = await port.fork(opened.store.header.id, root.id);
    const overview = await port.overview?.();

    expect(overview?.map((item) => item.id)).toContain(forkedId);
    expect(overview?.filter((item) => item.id === forkedId)).toHaveLength(1);
  });
});

describe("cost capture", () => {
  it("persists each finished turn's usage and rolls it into the overview", async () => {
    const dir = await tempDir();
    const port = sessionPort(dir, ".");
    const attachment = await port.create();
    const bus = new EventBus<EngineEvents>();
    attachment?.replay(bus);

    bus.emit("turn.delta", {
      delta: {
        type: "done",
        usage: { inputTokens: 9, outputTokens: 4, costUsd: 0.0021 },
      },
    });
    await attachment?.append(textMessage("user", "hi"));
    await attachment?.append(textMessage("assistant", "hey"));

    const file = await latestSessionFile(dir);
    const store = await SessionStore.open(file ?? "");
    const assistantEntry = store
      .entries()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant");
    expect(assistantEntry?.type === "message" && assistantEntry.usage).toEqual({
      inputTokens: 9,
      outputTokens: 4,
      costUsd: 0.0021,
    });
    expect(knownCostNanos(store.stats().cost)).toBe(2_100_000);

    const overview = await sessionTreePort(dir).overview?.();
    expect(overview?.at(0)?.costNanos).toBe(2_100_000);
  });

  it("stops listening to the bus when the session is released", async () => {
    const dir = await tempDir();
    const port = sessionPort(dir, ".");
    const attachment = await port.create();
    const bus = new EventBus<EngineEvents>();
    attachment?.replay(bus);
    expect(bus.listenerCount("turn.delta")).toBe(1);

    port.release?.(attachment?.id ?? "");

    expect(bus.listenerCount("turn.delta")).toBe(0);
  });

  it("never mistakes replayed usage for a fresh turn", async () => {
    const dir = await tempDir();
    const port = sessionPort(dir, ".");
    const attachment = await port.create();
    const bus = new EventBus<EngineEvents>();
    attachment?.replay(bus);

    bus.emit("turn.delta", {
      delta: { type: "done", usage: { inputTokens: 9, outputTokens: 4, costUsd: 1 } },
      replay: true,
    });
    await attachment?.append(textMessage("assistant", "restored reply"));

    const file = await latestSessionFile(dir);
    const store = await SessionStore.open(file ?? "");
    const entry = store.entries().at(0);
    expect(entry?.type === "message" && entry.usage).toBeUndefined();
  });

  it("keeps the overview honest when a session has unpriced usage", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    await opened.store.append(textMessage("assistant", "reply"), {
      inputTokens: 10,
      outputTokens: 5,
    });

    const overview = await sessionTreePort(dir).overview?.();
    expect(overview?.at(0)?.costNanos).toBeUndefined();
  });
});
