import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { processExists } from "../proc.ts";
import { installLanguageServerShim, lspFixtureServerPath } from "../testing/index.ts";
import { toolScope } from "../tools/confine.ts";
import type { SpawnLike } from "./path.ts";
import {
  type LanguagePort,
  type LanguagePortOptions,
  languagePort,
  type ServerState,
} from "./port.ts";

const tempDir = scratchDirs("keywork-lsp-");
const shimName = "lsp-fixture";

interface LogLine {
  level: string;
  event: string;
  payload: unknown;
}

interface Harness {
  port: LanguagePort;
  cwd: string;
  marker: string;
  trace: string;
  log: LogLine[];
  spawns: () => number;
  pids: number[];
  missing: string[];
}

async function harness(
  profile: string,
  overrides: Partial<LanguagePortOptions> = {},
): Promise<Harness> {
  const cwd = await tempDir();
  const shim = installLanguageServerShim(cwd, shimName, profile);
  const log: LogLine[] = [];
  const missing: string[] = [];
  let spawns = 0;
  const pids: number[] = [];
  const spawnFixture: SpawnLike = (_file, _args, options) => {
    spawns += 1;
    const child = spawn(
      process.execPath,
      [lspFixtureServerPath, profile, shim.marker, shim.trace],
      {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    if (child.pid !== undefined) pids.push(child.pid);
    return child;
  };
  const port = languagePort(toolScope(cwd), {
    servers: { typescript: { command: [shimName, "--stdio"], extensions: [".ts"] } },
    searchPath: cwd,
    spawn: spawnFixture,
    diagnostics: { log: (level, event, payload) => log.push({ level, event, payload }) },
    onMissing: (language) => missing.push(language),
    budgets: { initializeMs: 5_000, diagnosticsMs: 2_000 },
    ...overrides,
  });
  return {
    port,
    cwd,
    marker: shim.marker,
    trace: shim.trace,
    log,
    missing,
    pids,
    spawns: () => spawns,
  };
}

async function saved(harness: Harness, name: string, text: string) {
  const path = join(harness.cwd, name);
  await writeFile(path, text, "utf8");
  return { path, diagnostics: await harness.port.afterSave(path) };
}

function stateOf(port: LanguagePort, language = "typescript"): ServerState | undefined {
  return port.facts().servers.find((server) => server.language === language)?.state;
}

async function fixturePid(marker: string): Promise<number> {
  await waitFor(() => existsSync(marker));
  return Number(await readFile(marker, "utf8"));
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function traceOf(trace: string): Promise<string[]> {
  if (!existsSync(trace)) return [];
  return (await readFile(trace, "utf8")).split("\n").filter((line) => line !== "");
}

describe("languagePort", () => {
  it("returns the diagnostics the server publishes for the saved file, errors and warnings alike", async () => {
    const world = await harness("basic");
    const { path, diagnostics } = await saved(world, "cache.ts", "const a = 1;\nlet b = BROKEN;\n");
    expect(diagnostics).toEqual([
      {
        path,
        line: 2,
        column: 9,
        severity: "error",
        message: "Cannot find name 'BROKEN'.",
        source: "fixture",
      },
      {
        path,
        line: 2,
        column: 9,
        severity: "warning",
        message: "Unused marker.",
        source: "fixture",
      },
    ]);
    const facts = world.port.facts().servers[0];
    expect(facts?.state).toBe("ready");
    expect(facts?.pid).toBe(await fixturePid(world.marker));
    await world.port.dispose();
  });

  it("syncs later touches as full-text didChange and returns nothing once the file is clean", async () => {
    const world = await harness("basic");
    await saved(world, "cache.ts", "BROKEN");
    const clean = await saved(world, "cache.ts", "const fine = 1;\n");
    expect(clean.diagnostics).toEqual([]);
    expect(world.spawns()).toBe(1);
    expect(await traceOf(world.trace)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/didChange",
    ]);
    await world.port.dispose();
  });

  it("spawns nothing for a file no server owns", async () => {
    const world = await harness("basic");
    const { diagnostics } = await saved(world, "notes.md", "BROKEN");
    expect(diagnostics).toEqual([]);
    expect(world.spawns()).toBe(0);
    expect(stateOf(world.port)).toBe("idle");
    await world.port.dispose();
  });

  it("marks a command that is not on PATH missing, notices once, and never re-probes", async () => {
    const world = await harness("basic", { searchPath: "" });
    expect((await saved(world, "a.ts", "BROKEN")).diagnostics).toEqual([]);
    expect((await saved(world, "b.ts", "BROKEN")).diagnostics).toEqual([]);
    expect(world.spawns()).toBe(0);
    expect(stateOf(world.port)).toBe("missing");
    expect(world.missing).toEqual(["typescript"]);
    expect(world.log.map((line) => line.event)).toEqual(["lsp.missing"]);
    await world.port.dispose();
  });

  it("fails a server that misses the initialize budget, logs it, and kills the child", async () => {
    const world = await harness("slow-init", { budgets: { initializeMs: 300 } });
    expect((await saved(world, "a.ts", "BROKEN")).diagnostics).toEqual([]);
    expect(stateOf(world.port)).toBe("failed");
    expect(world.log).toContainEqual({
      level: "error",
      event: "lsp.failed",
      payload: { language: "typescript", reason: expect.stringContaining("initialize") },
    });
    expect(world.pids).toHaveLength(1);
    await waitFor(() => world.pids.every((pid) => !processExists(pid)));
    expect((await saved(world, "b.ts", "BROKEN")).diagnostics).toEqual([]);
    expect(world.spawns()).toBe(1);
    await world.port.dispose();
  });

  it("contains a crash after initialized as failed with the exit code and stderr, and never retries", async () => {
    const world = await harness("crash-once");
    expect((await saved(world, "a.ts", "BROKEN")).diagnostics).toEqual([]);
    await waitFor(() => stateOf(world.port) === "failed");
    expect((await saved(world, "b.ts", "BROKEN")).diagnostics).toEqual([]);
    expect(world.spawns()).toBe(1);
    const failure = world.log.find((line) => line.event === "lsp.failed");
    expect(failure?.payload).toEqual({
      language: "typescript",
      reason: expect.stringMatching(/exit 3 · .*crashing after initialized/),
    });
    expect(world.port.facts().servers[0]?.detail).toContain("exit 3");
    await world.port.dispose();
  });

  it("returns empty at the diagnostics budget when the server never publishes", async () => {
    const world = await harness("silent", { budgets: { diagnosticsMs: 200 } });
    const begun = Date.now();
    expect((await saved(world, "a.ts", "BROKEN")).diagnostics).toEqual([]);
    expect(Date.now() - begun).toBeLessThan(1_500);
    expect(stateOf(world.port)).toBe("ready");
    await world.port.dispose();
  });

  it("returns what is held when the caller aborts the wait", async () => {
    const world = await harness("silent", { budgets: { diagnosticsMs: 10_000 } });
    const path = join(world.cwd, "a.ts");
    await writeFile(path, "BROKEN");
    const controller = new AbortController();
    const waiting = world.port.afterSave(path, controller.signal);
    controller.abort();
    expect(await waiting).toEqual([]);
    await world.port.dispose();
  });

  it("shuts an idle server down with shutdown then exit under a stepping clock and restarts on the next touch", async () => {
    let clock = 0;
    const checks: Array<() => void> = [];
    const world = await harness("basic", {
      now: () => clock,
      budgets: { idleMs: 1_000 },
      scheduleIdleCheck: (check) => {
        checks.push(check);
        return () => {
          const index = checks.indexOf(check);
          if (index !== -1) checks.splice(index, 1);
        };
      },
    });
    await saved(world, "a.ts", "BROKEN");
    const pid = await fixturePid(world.marker);
    expect(checks).toHaveLength(1);

    clock = 500;
    checks[0]?.();
    expect(stateOf(world.port)).toBe("ready");
    expect(checks).toHaveLength(1);

    clock = 1_600;
    checks[0]?.();
    await waitFor(() => stateOf(world.port) === "idle");
    await waitFor(() => !processExists(pid));
    const trace = await traceOf(world.trace);
    expect(trace.slice(-2)).toEqual(["shutdown", "exit"]);

    expect((await saved(world, "a.ts", "BROKEN")).diagnostics).toHaveLength(2);
    expect(world.spawns()).toBe(2);
    await world.port.dispose();
  });

  it("kills a server that ignores shutdown and exit when it goes idle", async () => {
    let clock = 0;
    let check: (() => void) | undefined;
    const world = await harness("stubborn", {
      now: () => clock,
      budgets: { idleMs: 1_000 },
      scheduleIdleCheck: (next) => {
        check = next;
        return () => {};
      },
    });
    await saved(world, "a.ts", "BROKEN");
    const pid = await fixturePid(world.marker);
    clock = 5_000;
    check?.();
    await waitFor(() => !processExists(pid), 10_000);
    expect(stateOf(world.port)).toBe("idle");
    await world.port.dispose();
  });

  it("dispose leaves no live child, even one still initializing", async () => {
    const ready = await harness("basic");
    await saved(ready, "a.ts", "BROKEN");
    const readyPid = await fixturePid(ready.marker);
    await ready.port.dispose();
    expect(processExists(readyPid)).toBe(false);
    expect(stateOf(ready.port)).toBe("stopped");
    expect((await saved(ready, "b.ts", "BROKEN")).diagnostics).toEqual([]);

    const starting = await harness("slow-init", { budgets: { initializeMs: 30_000 } });
    const path = join(starting.cwd, "a.ts");
    await writeFile(path, "BROKEN");
    const pending = starting.port.afterSave(path);
    const startingPid = await fixturePid(starting.marker);
    await starting.port.dispose();
    expect(await pending).toEqual([]);
    await waitFor(() => !processExists(startingPid));
    expect(stateOf(starting.port)).toBe("stopped");
  });

  it("resolves the command on PATH and spawns the shim the way a user-installed server runs", async () => {
    const cwd = await tempDir();
    const shim = installLanguageServerShim(cwd, "typescript-language-server", "basic");
    const port = languagePort(toolScope(cwd), {
      servers: {
        typescript: { command: ["typescript-language-server", "--stdio"], extensions: [".ts"] },
      },
      searchPath: cwd,
    });
    const path = join(cwd, "cache.ts");
    await writeFile(path, "BROKEN");
    const diagnostics = await port.afterSave(path);
    expect(diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(["error", "warning"]);
    const pid = await fixturePid(shim.marker);
    await port.dispose();
    await waitFor(() => !processExists(pid));
  });
});
