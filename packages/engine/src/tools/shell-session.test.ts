import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processExists } from "../proc.ts";
import { persistentBashTool, ShellSession } from "./shell-session.ts";

const tempDirs: string[] = [];
const sessions: ShellSession[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-shell-"));
  tempDirs.push(dir);
  return dir;
}

async function openSession(): Promise<ShellSession> {
  const session = new ShellSession(await tempDir());
  sessions.push(session);
  return session;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ShellSession", () => {
  it("keeps a cwd change from call N live in call N+1", async () => {
    const root = await tempDir();
    await mkdir(join(root, "nested"));
    const session = new ShellSession(root);
    sessions.push(session);

    await session.run("cd nested");
    const pwd = await session.run("pwd");

    expect(basename(pwd.trim())).toBe("nested");
  });

  it("keeps exported environment live across calls", async () => {
    const session = await openSession();

    await session.run("export KW_SHELL_TEST=alive");
    const echoed = await session.run("echo $KW_SHELL_TEST");

    expect(echoed.trim()).toBe("alive");
  });

  it("returns to a clean shell after reset", async () => {
    const session = await openSession();
    await session.run("export KW_SHELL_TEST=stale");

    await session.reset();

    expect(session.running()).toBe(false);
    const echoed = await session.run("echo [$KW_SHELL_TEST]");
    expect(echoed.trim()).toBe("[]");
  });

  it("captures stderr and marks nonzero exit codes", async () => {
    const session = await openSession();

    const failure = await session.run("echo warned 1>&2; false");

    expect(failure).toContain("warned");
    expect(failure).toContain("(exit code 1)");
  });

  it("captures output without a trailing newline", async () => {
    const session = await openSession();

    expect(await session.run("printf partial")).toBe("partial");
  });

  it("kills the whole shell tree when the session closes", async () => {
    const session = await openSession();
    await session.run("echo warm");
    const pid = session.pid();

    await session.close();

    expect(pid).toBeDefined();
    expect(processExists(pid as number)).toBe(false);
    expect(session.running()).toBe(false);
  });

  it("kills a timed-out command's shell and starts fresh on the next call", async () => {
    const session = await openSession();
    await session.run("export KW_SHELL_TEST=doomed");

    await expect(session.run("sleep 30", { timeoutMs: 400 })).rejects.toThrow(
      "Command timed out after 400ms",
    );

    expect(session.running()).toBe(false);
    const echoed = await session.run("echo [$KW_SHELL_TEST]");
    expect(echoed.trim()).toBe("[]");
  });

  it("serializes concurrent runs on one shell", async () => {
    const session = await openSession();

    const [first, second] = await Promise.all([
      session.run("export KW_ORDER=first; echo one"),
      session.run("echo $KW_ORDER-two"),
    ]);

    expect(first.trim()).toBe("one");
    expect(second.trim()).toBe("first-two");
  });
});

describe("persistentBashTool", () => {
  it("exposes the session as the bash tool with persistence noted", async () => {
    const session = await openSession();
    const chunks: string[] = [];
    const tool = persistentBashTool(session, (chunk) => chunks.push(chunk));

    expect(tool.name).toBe("bash");
    expect(tool.description).toContain("persists across calls");
    expect(tool.mutates).toBe(true);

    await tool.execute({ command: "cd .. && pwd" });
    const output = await tool.execute({ command: "echo streamed" });

    expect(output.trim()).toBe("streamed");
    expect(chunks.join("")).toContain("streamed");
  });
});
