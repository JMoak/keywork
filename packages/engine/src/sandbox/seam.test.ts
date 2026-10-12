import { existsSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { afterEach, describe, expect, it } from "vitest";
import { bashTool, detectShell } from "../tools/bash.ts";
import {
  type BunPtyRuntime,
  type BunPtySpawnOptions,
  type BunTerminal,
  type PtySupport,
  probePtySupport,
} from "../tools/pty.ts";
import { openInteractiveShell, persistentBashTool, ShellSession } from "../tools/shell-session.ts";
import {
  type Launch,
  refusingSandbox,
  type Sandbox,
  SandboxRefusal,
  sandboxedToolNote,
  unconfined,
} from "./sandbox.ts";
import { fixedSandbox } from "./session.ts";

const tempDir = scratchDirs("keywork-seam-");
const shell = detectShell();
const sessions: ShellSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

const refusal = new SandboxRefusal("workspace", "no primitive on this host", "turn it off");

interface RecordingSandbox extends Sandbox {
  readonly launches: Launch[];
}

function recordingSandbox(
  rewrite: (launch: Launch) => Launch = (launch) => launch,
): RecordingSandbox {
  const launches: Launch[] = [];
  return {
    mode: "workspace",
    refusal: undefined,
    launches,
    confine: (launch) => {
      launches.push(launch);
      return rewrite(launch);
    },
  };
}

describe("the sandbox seam", () => {
  it("leaves a launch untouched when the sandbox is off", () => {
    const launch: Launch = { file: "sh", args: ["-c", "true"], cwd: "/w", env: { A: "1" } };
    expect(unconfined.confine(launch)).toBe(launch);
  });

  it("spawns the bash command the sandbox hands back, not the one it asked for", async () => {
    const cwd = await tempDir();
    const sandbox = recordingSandbox((launch) => ({
      ...launch,
      args: shell.args("echo confined"),
    }));

    const output = await bashTool(cwd, shell, undefined, fixedSandbox(sandbox)).execute({
      command: "echo original",
    });

    expect(output.trim()).toBe("confined");
    expect(sandbox.launches).toHaveLength(1);
    expect(sandbox.launches[0]).toMatchObject({
      file: shell.file,
      args: shell.args("echo original"),
      cwd,
    });
    expect(sandbox.launches[0]?.env.KEYWORK).toBe("1");
  });

  it("refuses a bash command before anything spawns when the sandbox refuses", async () => {
    const cwd = await tempDir();
    const tool = bashTool(cwd, shell, undefined, fixedSandbox(refusingSandbox(refusal)));

    await expect(tool.execute({ command: "echo ran > marker.txt" })).rejects.toThrow(
      "sandbox workspace refused: no primitive on this host · turn it off",
    );
    expect(existsSync(join(cwd, "marker.txt"))).toBe(false);
  });

  it("confines the persistent shell once, when it starts, not on every command", async () => {
    const session = new ShellSession(await tempDir(), shell);
    sessions.push(session);
    const sandbox = recordingSandbox();
    const tool = persistentBashTool(session, undefined, fixedSandbox(sandbox));

    await tool.execute({ command: "echo one" });
    const second = await tool.execute({ command: "echo two" });

    expect(second.trim()).toBe("two");
    expect(sandbox.launches).toHaveLength(1);
    expect(sandbox.launches[0]?.file).toBe(shell.file);
  });

  it("starts no persistent shell when the sandbox refuses", async () => {
    const session = new ShellSession(await tempDir(), shell);
    sessions.push(session);
    const tool = persistentBashTool(session, undefined, fixedSandbox(refusingSandbox(refusal)));

    await expect(tool.execute({ command: "echo hi" })).rejects.toBeInstanceOf(SandboxRefusal);
    expect(session.running()).toBe(false);
  });

  it("refuses the interactive pipe shell the same way", async () => {
    expect(() => openInteractiveShell(process.cwd(), shell, refusingSandbox(refusal))).toThrow(
      refusal.message,
    );
  });

  it("opens the pty shell through the sandbox", () => {
    const { runtime, spawned } = fakePtyRuntime();
    const sandbox = recordingSandbox((launch) => ({
      ...launch,
      file: "/usr/bin/bwrap",
      args: ["--", launch.file, ...launch.args],
    }));

    offeredPty(probePtySupport({ platform: "linux", runtime }, shell, sandbox)).open("/work", size);

    expect(spawned[0]?.command).toEqual(["/usr/bin/bwrap", "--", shell.file, ...ptyArgs()]);
    expect(spawned[0]?.options.cwd).toBe("/work");
  });

  it("allocates no terminal for a pty shell the sandbox refuses", () => {
    const { runtime, terminals } = fakePtyRuntime();
    const pty = offeredPty(
      probePtySupport({ platform: "linux", runtime }, shell, refusingSandbox(refusal)),
    );
    const probed = terminals.length;

    expect(() => pty.open("/work", size)).toThrow(refusal.message);
    expect(terminals).toHaveLength(probed);
  });

  it("tells the model what the sandbox does only when one is enforcing", () => {
    expect(sandboxedToolNote(unconfined)).toBe("");
    expect(sandboxedToolNote(refusingSandbox(refusal))).toBe("");
    expect(sandboxedToolNote(recordingSandbox())).toContain("Commands run sandboxed");
    expect(bashTool("/w", shell).description).not.toContain("sandboxed");
    expect(
      bashTool("/w", shell, undefined, fixedSandbox(recordingSandbox())).description,
    ).toContain("outside the workspace, temp and package caches fail");
  });
});

const size = { cols: 80, rows: 24 };

function offeredPty(support: PtySupport): Extract<PtySupport, { available: true }> {
  if (!support.available) throw new Error(`the fake runtime should offer a pty: ${support.reason}`);
  return support;
}

function ptyArgs(): string[] {
  return shell.name === "powershell" ? ["-NoLogo"] : ["-i"];
}

function fakePtyRuntime() {
  const terminals: BunTerminal[] = [];
  const spawned: { command: string[]; options: BunPtySpawnOptions }[] = [];
  const runtime: BunPtyRuntime = {
    Terminal: class implements BunTerminal {
      closed = false;
      constructor() {
        terminals.push(this);
      }
      write(data: string | Uint8Array): number {
        return data.length;
      }
      resize(): void {}
      close(): void {
        this.closed = true;
      }
    },
    spawn: (command, options) => {
      spawned.push({ command, options });
      return {
        pid: 4242,
        exited: new Promise<number>(() => {}),
        exitCode: null,
        signalCode: null,
        kill: () => {},
      };
    },
  };
  return { runtime, spawned, terminals };
}
