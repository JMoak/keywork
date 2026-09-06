import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { textMessage } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { sessionsCommand } from "./command.ts";
import { listSessions, openOrResumeSession } from "./store.ts";

const tempDir = scratchDirs("keywork-sessions-command-");

interface Console {
  out: string[];
  err: string[];
  io: { print: (line: string) => void; printError: (line: string) => void };
}

function consoleOf(): Console {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { print: (line) => out.push(line), printError: (line) => err.push(line) },
  };
}

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

describe("keywork sessions list", () => {
  it("lists sessions", async () => {
    const { dir } = await seededDir();
    const { out, io } = consoleOf();

    expect(await sessionsCommand([], dir, io)).toBe(0);
    expect(out.join("\n")).toContain("start");
  });

  it("prints the list as JSON when asked", async () => {
    const { dir, id } = await seededDir();
    const { out, io } = consoleOf();

    expect(await sessionsCommand(["list"], dir, { ...io, json: true })).toBe(0);
    const listed = JSON.parse(out.join("\n")) as { id: string }[];
    expect(listed.map((session) => session.id)).toEqual([id]);
  });

  it("says so when there are no sessions yet", async () => {
    const { out, io } = consoleOf();
    expect(await sessionsCommand([], join(await tempDir(), "nope"), io)).toBe(0);
    expect(out).toEqual(["no sessions yet"]);
  });

  it("reports unreadable files on stderr and keeps stdout JSON clean", async () => {
    const { dir, id } = await seededDir();
    const corrupt = join(dir, "0000000000001-0001-1.jsonl");
    await writeFile(corrupt, "{}\n", "utf8");
    const plain = consoleOf();
    const json = consoleOf();

    expect(await sessionsCommand([], dir, plain.io)).toBe(0);
    expect(plain.err).toEqual([expect.stringContaining(`skipping ${corrupt}`)]);
    expect(await sessionsCommand(["list"], dir, { ...json.io, json: true })).toBe(0);
    expect(json.err).toEqual([expect.stringContaining(`skipping ${corrupt}`)]);
    expect((JSON.parse(json.out.join("\n")) as { id: string }[]).map((row) => row.id)).toEqual([
      id,
    ]);
  });

  it("offers a prompted cleanup of header-only session files and deletes on consent", async () => {
    const { dir, emptyFile, keptFile } = await litteredDir();
    const { out, io } = consoleOf();
    const questions: string[] = [];

    const code = await sessionsCommand([], dir, {
      ...io,
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
    });

    expect(code).toBe(0);
    expect(questions).toHaveLength(1);
    expect(out.join("\n")).toContain("found 1 empty session file");
    expect(out.join("\n")).toContain("removed 1 empty session file");
    expect(existsSync(emptyFile)).toBe(false);
    expect(existsSync(keptFile)).toBe(true);
  });

  it("keeps every file when the cleanup is declined", async () => {
    const { dir, emptyFile, keptFile } = await litteredDir();

    await sessionsCommand([], dir, { ...consoleOf().io, confirm: async () => false });

    expect(existsSync(emptyFile)).toBe(true);
    expect(existsSync(keptFile)).toBe(true);
  });

  it("never prompts without a confirmer (non-TTY) and never during --json", async () => {
    const { dir, emptyFile } = await litteredDir();
    const questions: string[] = [];

    await sessionsCommand([], dir, consoleOf().io);
    await sessionsCommand(["list"], dir, {
      ...consoleOf().io,
      json: true,
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
    });

    expect(questions).toEqual([]);
    expect(existsSync(emptyFile)).toBe(true);
  });

  it("stays quiet when there is nothing to clean", async () => {
    const { dir } = await seededDir();
    const { out, io } = consoleOf();
    const questions: string[] = [];

    await sessionsCommand([], dir, {
      ...io,
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
    });

    expect(questions).toEqual([]);
    expect(out.join("\n")).not.toContain("empty session");
  });
});

describe("keywork sessions tree", () => {
  it("renders the tree with branch points and labels", async () => {
    const { dir, id } = await seededDir();
    const { out, io } = consoleOf();

    expect(await sessionsCommand(["tree", id.slice(0, 8)], dir, io)).toBe(0);
    const output = out.join("\n");
    expect(output).toContain("first branch");
    expect(output).toContain("second branch");
    expect(output).toContain("[good-path]");
  });

  it("defaults to the latest session", async () => {
    const { dir } = await seededDir();
    const { out, io } = consoleOf();

    expect(await sessionsCommand(["tree"], dir, io)).toBe(0);
    expect(out[0]).toMatch(/^session [0-9a-f]{8} · /);
  });

  it("fails on stderr for a missing id or an empty directory", async () => {
    const { dir } = await seededDir();
    const missing = consoleOf();
    expect(await sessionsCommand(["tree", "nope"], dir, missing.io)).toBe(1);
    expect(missing.err).toEqual(["no session matches id nope"]);
    expect(missing.out).toEqual([]);

    const empty = consoleOf();
    expect(await sessionsCommand(["tree"], await tempDir(), empty.io)).toBe(1);
    expect(empty.err).toEqual(["no sessions yet"]);
  });
});

describe("keywork sessions fork", () => {
  it("forks a session at a label into an independently continuable session", async () => {
    const { dir, id } = await seededDir();
    const { out, io } = consoleOf();

    expect(await sessionsCommand(["fork", id.slice(0, 8), "good-path"], dir, io)).toBe(0);
    expect(out[0]).toMatch(/^forked → [0-9a-f]{8} /);
    const { sessions } = await listSessions(dir);
    expect(sessions).toHaveLength(2);
    const forked = sessions.find((session) => session.id !== id);
    const resumed = await openOrResumeSession(dir, ".", { resumeId: forked?.id ?? "" });
    expect(resumed.seeded.map((message) => message.parts)).toEqual([
      textMessage("user", "start").parts,
      textMessage("assistant", "second branch").parts,
    ]);
    await resumed.store.append(textMessage("user", "forked continues"));
    expect((await openOrResumeSession(dir, ".", { resumeId: id })).seeded).toHaveLength(2);
  });

  it("fails on stderr when the ref matches nothing", async () => {
    const { dir, id } = await seededDir();
    const { err, io } = consoleOf();

    expect(await sessionsCommand(["fork", id, "no-such-label"], dir, io)).toBe(1);
    expect(err).toEqual(["no entry or label matches no-such-label"]);
  });
});

describe("keywork sessions usage", () => {
  it("rejects unknown subcommands as usage on stderr, exit 2", async () => {
    const { out, err, io } = consoleOf();

    expect(await sessionsCommand(["bogus"], await tempDir(), io)).toBe(2);
    expect(err).toEqual([
      'keywork sessions: unknown subcommand "bogus" (expected list, tree, or fork)',
    ]);
    expect(out).toEqual([]);
  });
});
