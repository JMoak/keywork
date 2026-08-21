import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EngineEvents,
  EventBus,
  knownCostNanos,
  SessionStore,
  textMessage,
} from "@keywork/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findSessionFile,
  latestSessionFile,
  listSessions,
  newSessionFileName,
  openOrResumeSession,
  sessionChangeFeed,
  sessionPort,
  sessionsCommand,
  sessionTreePort,
} from "./sessions.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-sessions-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("openOrResumeSession", () => {
  it("creates a fresh session when not resuming", async () => {
    const dir = await tempDir();

    const opened = await openOrResumeSession(dir, "C:\\repo");

    expect(opened.seeded).toEqual([]);
    expect(opened.store.header.cwd).toBe("C:\\repo");
  });

  it("resumes the most recent session with its messages", async () => {
    const dir = await tempDir();
    const first = await openOrResumeSession(dir, ".");
    await first.store.append(textMessage("user", "old question"));
    await first.store.append(textMessage("assistant", "old answer"));

    const resumed = await openOrResumeSession(dir, ".", { continueLatest: true });

    expect(resumed.store.file).toBe(first.store.file);
    expect(resumed.seeded.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("resumes a specific session by id prefix", async () => {
    const dir = await tempDir();
    const target = await openOrResumeSession(dir, ".");
    await target.store.append(textMessage("user", "find me"));
    const newer = await openOrResumeSession(dir, ".");
    await newer.store.append(textMessage("user", "not me"));

    const resumed = await openOrResumeSession(dir, ".", {
      resumeId: target.store.header.id.slice(0, 8),
    });

    expect(resumed.store.header.id).toBe(target.store.header.id);
    expect(resumed.seeded).toEqual([textMessage("user", "find me")]);
  });

  it("throws a clear error for an unknown resume id", async () => {
    const dir = await tempDir();

    await expect(openOrResumeSession(dir, ".", { resumeId: "nope" })).rejects.toThrow(
      /no session matches id nope/,
    );
  });

  it("falls back to a fresh session when resuming with no history", async () => {
    const dir = await tempDir();

    const opened = await openOrResumeSession(dir, ".", { continueLatest: true });

    expect(opened.seeded).toEqual([]);
  });

  it("appending after resume extends the same file", async () => {
    const dir = await tempDir();
    const first = await openOrResumeSession(dir, ".");
    await first.store.append(textMessage("user", "one"));

    const resumed = await openOrResumeSession(dir, ".", { continueLatest: true });
    await resumed.store.append(textMessage("assistant", "two"));

    const reread = await openOrResumeSession(dir, ".", { continueLatest: true });
    expect(reread.seeded).toHaveLength(2);
  });
});

describe("listSessions", () => {
  it("lists id, title, timestamps, and message count, newest first", async () => {
    const dir = await tempDir();
    const first = await openOrResumeSession(dir, ".");
    await first.store.append(textMessage("user", "explain the parser"));
    const second = await openOrResumeSession(dir, ".");
    await second.store.append(textMessage("user", "fix the tests"));
    await second.store.setName("test-fixing");

    const sessions = await listSessions(dir);

    expect(sessions).toHaveLength(2);
    const titles = sessions.map((session) => session.title);
    expect(titles).toContain("explain the parser");
    expect(titles).toContain("test-fixing");
    for (const session of sessions) {
      expect(session.id).not.toBe("");
      expect(session.messageCount).toBe(1);
      expect(session.modifiedAt.getTime()).toBeGreaterThan(0);
    }
  });

  it("returns an empty list for a missing directory", async () => {
    expect(await listSessions(join(await tempDir(), "nope"))).toEqual([]);
  });
});

describe("sessionsCommand", () => {
  async function seededDir(): Promise<{ dir: string; id: string }> {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    const root = await opened.store.append(textMessage("user", "start"));
    await opened.store.append(textMessage("assistant", "first branch"));
    opened.store.branch(root.id);
    const tip = await opened.store.append(textMessage("assistant", "second branch"));
    await opened.store.setLabel(tip.id, "good-path");
    return { dir, id: opened.store.header.id };
  }

  it("lists sessions", async () => {
    const { dir } = await seededDir();
    const lines: string[] = [];

    const code = await sessionsCommand([], dir, (line) => lines.push(line));

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("start");
  });

  it("renders the tree with branch points and labels", async () => {
    const { dir, id } = await seededDir();
    const lines: string[] = [];

    const code = await sessionsCommand(["tree", id.slice(0, 8)], dir, (line) => lines.push(line));

    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("first branch");
    expect(output).toContain("second branch");
    expect(output).toContain("[good-path]");
  });

  it("forks a session at a label into an independently continuable session", async () => {
    const { dir, id } = await seededDir();
    const lines: string[] = [];

    const code = await sessionsCommand(["fork", id.slice(0, 8), "good-path"], dir, (line) =>
      lines.push(line),
    );

    expect(code).toBe(0);
    const sessions = await listSessions(dir);
    expect(sessions).toHaveLength(2);
    const forked = sessions.find((session) => session.id !== id);
    const resumed = await openOrResumeSession(dir, ".", {
      resumeId: (forked as { id: string }).id,
    });
    expect(resumed.seeded.map((message) => message.parts)).toEqual([
      textMessage("user", "start").parts,
      textMessage("assistant", "second branch").parts,
    ]);
    await resumed.store.append(textMessage("user", "forked continues"));
    expect((await openOrResumeSession(dir, ".", { resumeId: id })).seeded).toHaveLength(2);
  });

  it("rejects unknown subcommands and missing ids", async () => {
    const dir = await tempDir();
    const lines: string[] = [];

    expect(await sessionsCommand(["bogus"], dir, (line) => lines.push(line))).toBe(1);
    expect(await sessionsCommand(["tree", "nope"], dir, (line) => lines.push(line))).toBe(1);
  });

  async function litteredDir(): Promise<{ dir: string; emptyFile: string; keptFile: string }> {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    await opened.store.append(textMessage("user", "keep me"));
    const emptyFile = join(dir, "1000000000000-0001-1.jsonl");
    await writeFile(
      emptyFile,
      '{"type":"session","id":"empty-legacy","cwd":".","createdAt":"2026-01-01T00:00:00.000Z"}\n',
      "utf8",
    );
    return { dir, emptyFile, keptFile: opened.store.file };
  }

  it("offers a prompted cleanup of header-only session files and deletes on consent", async () => {
    const { dir, emptyFile, keptFile } = await litteredDir();
    const lines: string[] = [];
    const questions: string[] = [];

    const code = await sessionsCommand(
      [],
      dir,
      (line) => lines.push(line),
      async (question) => {
        questions.push(question);
        return true;
      },
    );

    expect(code).toBe(0);
    expect(questions).toHaveLength(1);
    expect(lines.join("\n")).toContain("found 1 empty session file");
    expect(lines.join("\n")).toContain("removed 1 empty session file");
    expect(existsSync(emptyFile)).toBe(false);
    expect(existsSync(keptFile)).toBe(true);
  });

  it("keeps every file when the cleanup is declined", async () => {
    const { dir, emptyFile, keptFile } = await litteredDir();

    await sessionsCommand(
      [],
      dir,
      () => {},
      async () => false,
    );

    expect(existsSync(emptyFile)).toBe(true);
    expect(existsSync(keptFile)).toBe(true);
  });

  it("never prompts without a confirmer (non-TTY) and never during --json", async () => {
    const { dir, emptyFile } = await litteredDir();
    const questions: string[] = [];

    await sessionsCommand([], dir, () => {});
    await sessionsCommand(
      ["list", "--json"],
      dir,
      () => {},
      async (question) => {
        questions.push(question);
        return true;
      },
    );

    expect(questions).toEqual([]);
    expect(existsSync(emptyFile)).toBe(true);
  });

  it("stays quiet when there is nothing to clean", async () => {
    const { dir } = await seededDir();
    const lines: string[] = [];
    const questions: string[] = [];

    await sessionsCommand(
      [],
      dir,
      (line) => lines.push(line),
      async (question) => {
        questions.push(question);
        return true;
      },
    );

    expect(questions).toEqual([]);
    expect(lines.join("\n")).not.toContain("empty session");
  });
});

describe("newSessionFileName", () => {
  it("creates distinct sessions within the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1754800000000);
    const dir = await tempDir();

    const first = await openOrResumeSession(dir, ".");
    const second = await openOrResumeSession(dir, ".");

    expect(first.store.file).not.toBe(second.store.file);
  });

  it("stays filesystem-safe and sortable by creation with a frozen clock", () => {
    vi.spyOn(Date, "now").mockReturnValue(1754800000000);

    const names = [newSessionFileName(), newSessionFileName(), newSessionFileName()];

    for (const name of names) expect(name).toMatch(/^\d{13}-\d{4,}-\d+\.jsonl$/);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
  });

  it("sorts a later session after an earlier one", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1754800000000);
    const earlier = newSessionFileName();
    now.mockReturnValue(1754800000001);
    const later = newSessionFileName();

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe("latestSessionFile", () => {
  it("returns undefined for a missing directory", async () => {
    expect(await latestSessionFile(join(await tempDir(), "nope"))).toBeUndefined();
  });
});

describe("findSessionFile", () => {
  it("finds a materialized session by id prefix", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    await opened.store.append(textMessage("user", "make it real"));

    expect(await findSessionFile(dir, opened.store.header.id.slice(0, 6))).toBe(opened.store.file);
    expect(await findSessionFile(dir, "zzzzzz")).toBeUndefined();
  });

  it("cannot find a session that was never used", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");

    expect(await findSessionFile(dir, opened.store.header.id.slice(0, 6))).toBeUndefined();
  });
});

describe("sessionPort", () => {
  it("tags persisted user turns with the pending checkpoint tree", async () => {
    const dir = await tempDir();
    const tags = ["tree-one", "tree-two"];
    const port = sessionPort(dir, ".", () => tags.shift());
    const attachment = await port.create();

    await attachment?.append(textMessage("user", "mutating turn"));
    await attachment?.append(textMessage("assistant", "done"));
    await attachment?.append(textMessage("user", "another mutating turn"));
    await attachment?.append(textMessage("user", "read-only turn"));

    const file = await findSessionFile(dir, attachment?.id ?? "");
    const store = await SessionStore.open(file ?? "");
    const entries = store.entries();
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

    const file = await findSessionFile(dir, attachment?.id ?? "");
    const store = await SessionStore.open(file ?? "");
    expect(store.entries()[0]).not.toHaveProperty("checkpoint");
  });

  it("a created session never written to leaves no file on disk", async () => {
    const dir = await tempDir();
    const port = sessionPort(dir, ".");

    const attachment = await port.create();

    expect(attachment).toBeDefined();
    expect(await readdir(dir)).toEqual([]);
    expect(await listSessions(dir)).toEqual([]);
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
    expect((await listSessions(dir))[0]?.title).toBe("tidy-title");
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
    const sessions = await listSessions(dir);
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

  it("keeps header-only session files out of the overview", async () => {
    const dir = await tempDir();
    const used = await openOrResumeSession(dir, ".");
    await used.store.append(textMessage("user", "hello"));
    const headerLine = (await readFile(used.store.file, "utf8")).split("\n")[0] ?? "";
    const phantomHeader = headerLine.replace(
      used.store.header.id,
      "00000000-aaaa-bbbb-cccc-000000000000",
    );
    await writeFile(join(dir, newSessionFileName()), `${phantomHeader}\n`);
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
