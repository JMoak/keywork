import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textMessage } from "@keywork/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findSessionFile,
  latestSessionFile,
  listSessions,
  newSessionFileName,
  openOrResumeSession,
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
  it("finds a session by id prefix", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");

    expect(await findSessionFile(dir, opened.store.header.id.slice(0, 6))).toBe(opened.store.file);
    expect(await findSessionFile(dir, "zzzzzz")).toBeUndefined();
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
});
