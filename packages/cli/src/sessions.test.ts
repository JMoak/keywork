import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textMessage } from "@keywork/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { latestSessionFile, newSessionFileName, openOrResumeSession } from "./sessions.ts";

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

    const opened = await openOrResumeSession(dir, "C:\\repo", false);

    expect(opened.seeded).toEqual([]);
    expect(opened.store.header.cwd).toBe("C:\\repo");
  });

  it("resumes the most recent session with its messages", async () => {
    const dir = await tempDir();
    const first = await openOrResumeSession(dir, ".", false);
    await first.store.append(textMessage("user", "old question"));
    await first.store.append(textMessage("assistant", "old answer"));

    const resumed = await openOrResumeSession(dir, ".", true);

    expect(resumed.store.file).toBe(first.store.file);
    expect(resumed.seeded.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("falls back to a fresh session when resuming with no history", async () => {
    const dir = await tempDir();

    const opened = await openOrResumeSession(dir, ".", true);

    expect(opened.seeded).toEqual([]);
  });

  it("appending after resume extends the same file", async () => {
    const dir = await tempDir();
    const first = await openOrResumeSession(dir, ".", false);
    await first.store.append(textMessage("user", "one"));

    const resumed = await openOrResumeSession(dir, ".", true);
    await resumed.store.append(textMessage("assistant", "two"));

    const reread = await openOrResumeSession(dir, ".", true);
    expect(reread.seeded).toHaveLength(2);
  });
});

describe("newSessionFileName", () => {
  it("creates distinct sessions within the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1754800000000);
    const dir = await tempDir();

    const first = await openOrResumeSession(dir, ".", false);
    const second = await openOrResumeSession(dir, ".", false);

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
