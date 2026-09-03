import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { textMessage } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it, vi } from "vitest";
import {
  findSession,
  latestSessionFile,
  listSessions,
  newSessionFileName,
  openOrResumeSession,
  scanSessions,
} from "./store.ts";

const tempDir = scratchDirs("keywork-sessions-store-");

async function corruptFile(dir: string): Promise<string> {
  const file = join(dir, "0000000000001-0001-1.jsonl");
  await writeFile(file, '{"type":"message","nope":true}\n', "utf8");
  return file;
}

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

describe("scanSessions", () => {
  it("treats a missing directory as having no sessions", async () => {
    expect(await scanSessions(join(await tempDir(), "nope"))).toEqual({
      stores: [],
      unreadable: [],
    });
  });

  it("opens every readable session and names the files it could not read", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    await opened.store.append(textMessage("user", "hello"));
    const corrupt = await corruptFile(dir);

    const scan = await scanSessions(dir);

    expect(scan.stores.map((store) => store.header.id)).toEqual([opened.store.header.id]);
    expect(scan.unreadable).toEqual([
      { file: corrupt, reason: expect.stringContaining("not a keywork session file") },
    ]);
  });

  it("surfaces a directory that cannot be listed instead of reporting no sessions", async () => {
    const unlistable = `${await tempDir()}\0`;

    await expect(scanSessions(unlistable)).rejects.toThrow();
  });
});

describe("listSessions", () => {
  it("summarizes id, title, timestamps, counts, and cost, newest first", async () => {
    const dir = await tempDir();
    const first = await openOrResumeSession(dir, ".");
    await first.store.append(textMessage("user", "explain the parser"));
    const second = await openOrResumeSession(dir, ".");
    await second.store.append(textMessage("user", "fix the tests"));
    await second.store.setName("test-fixing");

    const { sessions, unreadable } = await listSessions(dir);

    expect(unreadable).toEqual([]);
    expect(sessions).toHaveLength(2);
    const titles = sessions.map((session) => session.title);
    expect(titles).toContain("explain the parser");
    expect(titles).toContain("test-fixing");
    for (const session of sessions) {
      expect(session.id).not.toBe("");
      expect(session.messageCount).toBe(1);
      expect(session.entryCount).toBeGreaterThanOrEqual(1);
      expect(session.modifiedAt.getTime()).toBeGreaterThan(0);
      expect(Date.parse(session.lastActivityAt)).toBeGreaterThan(0);
      expect(session.costNanos).toBeUndefined();
    }
  });

  it("titles an unnamed session with no user text as untitled", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    await opened.store.append(textMessage("assistant", "reply"));

    expect((await listSessions(dir)).sessions[0]?.title).toBe("(untitled session)");
  });

  it("returns an empty list for a missing directory", async () => {
    expect(await listSessions(join(await tempDir(), "nope"))).toEqual({
      sessions: [],
      unreadable: [],
    });
  });

  it("keeps listing around an unreadable file and reports it", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    await opened.store.append(textMessage("user", "keep"));
    const corrupt = await corruptFile(dir);

    const { sessions, unreadable } = await listSessions(dir);

    expect(sessions.map((session) => session.id)).toEqual([opened.store.header.id]);
    expect(unreadable.map((problem) => problem.file)).toEqual([corrupt]);
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

describe("findSession", () => {
  it("finds a materialized session by id prefix", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");
    await opened.store.append(textMessage("user", "make it real"));

    expect((await findSession(dir, opened.store.header.id.slice(0, 6)))?.file).toBe(
      opened.store.file,
    );
    expect(await findSession(dir, "zzzzzz")).toBeUndefined();
  });

  it("cannot find a session that was never used", async () => {
    const dir = await tempDir();
    const opened = await openOrResumeSession(dir, ".");

    expect(await findSession(dir, opened.store.header.id.slice(0, 6))).toBeUndefined();
  });

  it("looks past unreadable files", async () => {
    const dir = await tempDir();
    await corruptFile(dir);
    const opened = await openOrResumeSession(dir, ".");
    await opened.store.append(textMessage("user", "still here"));

    expect((await findSession(dir, opened.store.header.id))?.header.id).toBe(
      opened.store.header.id,
    );
  });
});
