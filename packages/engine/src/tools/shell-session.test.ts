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

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function caughtFailure(cause: unknown): unknown {
  return cause;
}

function expectMissingExecutable(outcome: unknown, executable: string): void {
  expect(outcome).toBeInstanceOf(Error);
  const failure = outcome as NodeJS.ErrnoException;
  expect(failure.code).toBe("ENOENT");
  expect(failure.message).toContain(executable);
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

  it("caps a newline-free flood without buffering it whole", async () => {
    const session = await openSession();

    const output = await session.run("head -c 100000 /dev/zero | tr '\\0' x; echo; echo tail");

    expect(output.length).toBeLessThan(31_000);
    expect(output).toContain("truncated");
    expect((await session.run("echo still-alive")).trim()).toBe("still-alive");
  }, 10_000);

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

describe("ShellSession failures", () => {
  it("rejects run() with the spawn error when the shell cannot start", async () => {
    const missingShell = "definitely-not-a-shell-xyz";
    const session = new ShellSession(await tempDir(), {
      file: missingShell,
      args: () => [],
      name: "sh",
    });
    sessions.push(session);

    expectMissingExecutable(await session.run("echo hi").catch(caughtFailure), missingShell);
    expect(session.running()).toBe(false);
    expectMissingExecutable(await session.run("echo again").catch(caughtFailure), missingShell);
    expect(session.running()).toBe(false);
  });

  it("notices a shell that died between commands and starts fresh", async () => {
    const session = await openSession();
    await session.run("(sleep 0.2; kill -9 $$) & echo armed");
    const pid = session.pid();
    expect(pid).toBeDefined();

    await waitUntil(() => !session.running(), 5_000);

    expect(session.running()).toBe(false);
    expect((await session.run("echo fresh")).trim()).toBe("fresh");
  }, 15_000);

  it("starts a fresh shell after the old one exited on its own", async () => {
    const session = await openSession();

    const exited = await session.run("exit 0");
    expect(exited).toContain("shell exited");
    expect(session.running()).toBe(false);

    expect((await session.run("echo back")).trim()).toBe("back");
  });
});

const powershell = {
  file: "powershell.exe",
  args: (command: string) => ["-NoProfile", "-NonInteractive", "-Command", command],
  name: "powershell",
};

describe.skipIf(process.platform !== "win32")("ShellSession over PowerShell", () => {
  async function openPowerShell(): Promise<ShellSession> {
    const session = new ShellSession(await tempDir(), powershell);
    sessions.push(session);
    return session;
  }

  it("keeps a cwd change live in the next call", async () => {
    const root = await tempDir();
    await mkdir(join(root, "nested"));
    const session = new ShellSession(root, powershell);
    sessions.push(session);

    await session.run("cd nested");
    const pwd = await session.run("(Get-Location).Path");

    expect(basename(pwd.trim())).toBe("nested");
  }, 20_000);

  it("keeps environment variables live across calls", async () => {
    const session = await openPowerShell();

    await session.run('$env:KW_SHELL_TEST = "alive"');
    const echoed = await session.run("Write-Output $env:KW_SHELL_TEST");

    expect(echoed.trim()).toBe("alive");
  }, 20_000);

  it("captures stderr and marks a failed command with exit code 1", async () => {
    const session = await openPowerShell();

    const failure = await session.run("Get-Item C:\\keywork\\definitely\\missing");

    expect(failure).toContain("Cannot find path");
    expect(failure).toContain("(exit code 1)");
    expect(await session.run("Write-Output ok")).toBe("ok");
  }, 20_000);

  it("kills a timed-out command's shell and starts fresh on the next call", async () => {
    const session = await openPowerShell();
    await session.run('$env:KW_SHELL_TEST = "doomed"');

    await expect(session.run("Start-Sleep -Seconds 30", { timeoutMs: 400 })).rejects.toThrow(
      "Command timed out after 400ms",
    );

    expect(session.running()).toBe(false);
    const echoed = await session.run('Write-Output "[$env:KW_SHELL_TEST]"');
    expect(echoed.trim()).toBe("[]");
  }, 20_000);
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
