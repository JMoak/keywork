import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { processExists } from "../proc.ts";
import { BoundedOutput, commandResult, retainedOutputChars } from "./command-run.ts";
import { persistentBashTool, SentinelScanner, ShellSession } from "./shell-session.ts";

const tempDir = scratchDirs("keywork-shell-");
const sessions: ShellSession[] = [];

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

  it("refuses an already-aborted signal without touching the shell", async () => {
    const session = await openSession();

    await expect(session.run("echo never", { signal: AbortSignal.abort() })).rejects.toThrow(
      /abort/i,
    );

    expect(session.running()).toBe(false);
  });

  it("kills the shell when the signal aborts mid-command and starts fresh next time", async () => {
    const session = await openSession();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    await expect(
      session.run("sleep 30", { timeoutMs: 20_000, signal: controller.signal }),
    ).rejects.toThrow(/Command aborted/);
    await waitUntil(() => !session.running(), 3_000);

    expect(session.running()).toBe(false);
    expect((await session.run("echo fresh")).trim()).toBe("fresh");
  }, 10_000);

  it("lets a 100k newline-free line through whole", async () => {
    const session = await openSession();

    const output = await session.run("head -c 100000 /dev/zero | tr '\\0' x; echo; echo tail");

    expect(output.length).toBe(100_000 + "\ntail".length);
    expect(output.endsWith("tail")).toBe(true);
  }, 10_000);

  it("keeps the head and the tail of a flood past the retained ceiling without buffering it whole", async () => {
    const session = await openSession();
    const flood = retainedOutputChars + 200_000;

    const output = await session.run(`head -c ${flood} /dev/zero | tr '\\0' x; echo; echo tail`);

    expect(output.length).toBeLessThan(retainedOutputChars + 100);
    expect(output).toContain("characters elided from the middle");
    expect(output.endsWith("tail")).toBe(true);
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

  it("answers each command exactly what it printed, from the very first on a fresh shell", async () => {
    const session = await openSession();

    expect(await session.run("printf warned >&2")).toBe("warned");
    expect(await session.run("true")).toBe("");
    expect(await session.run("printf 'a\\n\\nb\\n\\n\\n'")).toBe("a\n\nb");
    expect(await session.run("echo whole")).toBe("whole");
  });
});

describe("a framed command's answer", () => {
  it("is exactly what the command printed without a trailing newline, whichever frame is read first", () => {
    expect(answerTo(["stderr", stderrFrame], ["stdout", "partial"], ["stdout", stdoutFrame])).toBe(
      "partial",
    );
    expect(answerTo(["stdout", `partial${stdoutFrame}`], ["stderr", stderrFrame])).toBe("partial");
  });

  it("ends at the command's last text, however many newlines close it, and keeps the blank lines inside", () => {
    expect(answerTo(["stderr", stderrFrame], ["stdout", `whole\n${stdoutFrame}`])).toBe("whole");
    expect(answerTo(["stderr", stderrFrame], ["stdout", `a\n\nb\n\n\n${stdoutFrame}`])).toBe(
      "a\n\nb",
    );
  });

  it("is empty when the command printed nothing", () => {
    expect(answerTo(["stderr", stderrFrame], ["stdout", stdoutFrame])).toBe("");
    expect(answerTo(["stdout", stdoutFrame], ["stderr", stderrFrame])).toBe("");
  });

  it("reads stderr that ends without a newline", () => {
    expect(answerTo(["stdout", stdoutFrame], ["stderr", `warned${stderrFrame}`])).toBe("warned");
  });
});

const sentinel = "__keywork_framed__";
const stdoutFrame = `\n${sentinel} 0\n`;
const stderrFrame = `\n${sentinel}\n`;

function answerTo(...arrivals: Array<["stdout" | "stderr", string]>): string {
  const output = new BoundedOutput();
  let exitCode = 0;
  const streams = {
    stdout: new SentinelScanner(sentinel, output, (code) => {
      exitCode = code ?? 0;
    }),
    stderr: new SentinelScanner(sentinel, output, () => undefined),
  };
  for (const [stream, chunk] of arrivals) streams[stream].push(chunk);
  return commandResult(output.rendered(), exitCode);
}

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
  beforeAll(async () => {
    const warmup = new ShellSession(await tempDir(), powershell);
    await warmup.run("Write-Output warm", { timeoutMs: 110_000 });
    await warmup.close();
  }, 120_000);

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
