import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { conflictMarkers, leaseFile, localHost, markMultiHostVault } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { openWorkspaceMemory } from "./memory.ts";
import {
  describeReconciliation,
  memoryCommand,
  mergeAttributesLine,
  mergeDriverCommand,
  mergeDriverName,
} from "./memory-command.ts";

const scratch = scratchDirs("keywork-cli-memory-sync-");
const at = new Date("2026-08-10T09:00:00Z");

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    print: (line: string) => out.push(line),
    printError: (line: string) => err.push(line),
  };
}

async function workspace(): Promise<{ cwd: string; vault: string }> {
  const cwd = await scratch();
  await mkdir(join(cwd, ".keywork"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "fixture" }));
  return { cwd, vault: join(cwd, ".keywork", "memory") };
}

function opened(cwd: string) {
  const memory = openWorkspaceMemory(cwd, true);
  if (memory === undefined) throw new Error("expected a workspace memory");
  return memory;
}

describe("keywork memory sync", () => {
  it("reports a single-host vault and heals conflict markers it finds", async () => {
    const { cwd, vault } = await workspace();
    const memory = opened(cwd);
    await memory.store.writeNote({ title: "Runtime", body: "bun\n", provenance: "agent" });
    const ours = await readFile(join(vault, "Runtime.md"), "utf8");
    await writeFile(
      join(vault, "Runtime.md"),
      conflictMarkers({ ours, theirs: ours.replace("bun", "deno") }),
    );
    const io = recorder();
    const code = await memoryCommand(
      ["sync"],
      { cwd, trusted: true },
      io,
      {},
      {
        memory: () => memory,
        now: () => at,
      },
    );
    expect(code).toBe(0);
    expect(io.out).toEqual([
      "layout: single host · keywork memory sync setup lets more hosts write this vault",
      "hosts seen: none yet",
      "sweep lease: free",
      "quarantined Runtime · copy kept as Runtime (conflict copy) (markers)",
      "1 inbox card staged",
      "index: 2 notes · 0 refreshed · 0 dropped",
    ]);
  });

  it("reports hosts and a foreign lease on a multi-host vault", async () => {
    const { cwd, vault } = await workspace();
    await markMultiHostVault(vault);
    const memory = opened(cwd);
    await memory.store.appendDaily("x", "user");
    await mkdir(join(vault, ".sync"), { recursive: true });
    await writeFile(
      join(vault, leaseFile),
      JSON.stringify({
        host: "beta",
        acquired: at.toISOString(),
        expires: "2026-08-10T09:10:00.000Z",
      }),
    );
    const io = recorder();
    await memoryCommand(
      ["sync"],
      { cwd, trusted: true },
      io,
      {},
      { memory: () => memory, now: () => at },
    );
    expect(io.out.slice(0, 3)).toEqual([
      `layout: per host · this host writes as ${localHost()}`,
      `hosts seen: ${localHost()}`,
      "sweep lease: held by beta until 2026-08-10T09:10:00.000Z",
    ]);
    const stale = describeReconciliation(
      {
        host: localHost(),
        hosts: [],
        intake: [],
        restored: [],
        cards: [],
        lease: { host: localHost(), acquired: "", expires: "2026-08-10T08:00:00.000Z" },
        index: undefined,
      },
      at,
    );
    expect(stale[2]).toBe(
      "sweep lease: stale, left by this host, expired 2026-08-10T08:00:00.000Z · the next sweep takes it over",
    );
  });

  it("refuses when memory is absent, inert, or the verb is unknown", async () => {
    const { cwd } = await workspace();
    const io = recorder();
    expect(await memoryCommand(["sync"], { cwd, trusted: false }, io)).toBe(2);
    expect(await memoryCommand(["sync", "bogus"], { cwd, trusted: true }, io)).toBe(2);
    expect(await memoryCommand(["sync", "merge", "a"], { cwd, trusted: true }, io)).toBe(2);
    expect(io.err).toEqual([
      "keywork memory: memory is inert in an untrusted workspace",
      'keywork memory: unknown sync verb "bogus" (expected setup or merge)',
      "keywork memory: sync merge needs <base> <ours> <theirs> [path]",
    ]);
  });
});

describe("keywork memory sync setup", () => {
  it("marks the vault, then registers the merge driver when git is there", async () => {
    const { cwd, vault } = await workspace();
    const memory = opened(cwd);
    const calls: string[][] = [];
    const git = async (dir: string, args: readonly string[]) => {
      calls.push([dir, ...args]);
      return args[0] === "rev-parse" ? `${cwd}\n` : "";
    };
    const io = recorder();
    expect(
      await memoryCommand(
        ["sync", "setup"],
        { cwd, trusted: true },
        io,
        {},
        { memory: () => memory, git },
      ),
    ).toBe(0);
    expect(io.out).toEqual([
      "per-host layout: on · daily logs and the curation ledger now write per host",
      `git: merge driver ${mergeDriverName} registered in ${cwd} · .gitattributes written`,
    ]);
    expect(calls).toEqual([
      [vault, "rev-parse", "--show-toplevel"],
      [cwd, "config", `merge.${mergeDriverName}.name`, "keywork memory vault merge"],
      [cwd, "config", `merge.${mergeDriverName}.driver`, mergeDriverCommand],
    ]);
    expect(await readFile(join(vault, ".gitattributes"), "utf8")).toBe(`${mergeAttributesLine}\n`);
    expect(await readFile(join(vault, ".sync", "layout.json"), "utf8")).toContain("per-host");
    const again = recorder();
    await memoryCommand(
      ["sync", "setup"],
      { cwd, trusted: true },
      again,
      {},
      { memory: () => memory, git },
    );
    expect(again.out[0]).toBe("per-host layout: already on");
    expect(await readFile(join(vault, ".gitattributes"), "utf8")).toBe(`${mergeAttributesLine}\n`);
  });

  it("skips the driver outside a repository", async () => {
    const { cwd } = await workspace();
    const memory = opened(cwd);
    const io = recorder();
    const git = async () => {
      throw new Error("not a git repository");
    };
    await memoryCommand(
      ["sync", "setup"],
      { cwd, trusted: true },
      io,
      {},
      { memory: () => memory, git },
    );
    expect(io.out[1]).toBe("git: the vault is not inside a repository · merge driver skipped");
  });
});

describe("keywork memory sync merge", () => {
  async function sides(dir: string, base: string, ours: string, theirs: string) {
    const paths = { base: join(dir, "base"), ours: join(dir, "ours"), theirs: join(dir, "theirs") };
    await writeFile(paths.base, base);
    await writeFile(paths.ours, ours);
    await writeFile(paths.theirs, theirs);
    return paths;
  }

  it("writes the merge into ours and exits 0, or leaves markers and exits 1", async () => {
    const dir = await scratch();
    const { cwd } = await workspace();
    const merged = await sides(dir, "a\n", "a\nb\n", "a\nc\n");
    const io = recorder();
    const args = ["sync", "merge", merged.base, merged.ours, merged.theirs, "Note.md"];
    expect(await memoryCommand(args, { cwd, trusted: true }, io)).toBe(0);
    expect(await readFile(merged.ours, "utf8")).toBe("a\nb\nc\n");
    const clashed = await sides(dir, "a\n", "b\n", "c\n");
    const clash = ["sync", "merge", clashed.base, clashed.ours, clashed.theirs, "Note.md"];
    expect(await memoryCommand(clash, { cwd, trusted: true }, io)).toBe(1);
    expect(await readFile(clashed.ours, "utf8")).toBe(
      conflictMarkers({ ours: "b\n", theirs: "c\n" }),
    );
    expect(io.out).toEqual([
      "keywork memory: both hosts rewrote Note.md · keywork memory sync keeps the copy as a sibling note",
    ]);
  });
});

describe("the merge driver at git merge", () => {
  const main = resolve(import.meta.dirname, "main.ts").replaceAll("\\", "/");
  const toolchain = Promise.all([which("git"), which("bun")]).then((found) => found.every(Boolean));

  it("resolves a derived-frontmatter divergence without a conflict", async () => {
    if (!(await toolchain)) return;
    const repo = await scratch();
    const run = (args: string[]) => exec("git", args, repo);
    await run(["init", "-q", "-b", "main"]);
    await run(["config", "user.email", "t@example.com"]);
    await run(["config", "user.name", "t"]);
    await run(["config", "core.autocrlf", "false"]);
    await run([
      "config",
      `merge.${mergeDriverName}.driver`,
      `bun "${main}" memory sync merge %O %A %B %P`,
    ]);
    await writeFile(join(repo, ".gitattributes"), `${mergeAttributesLine}\n`);
    const note = (usefulness: string, body: string) =>
      `---\nprovenance: "agent"\nusefulness: ${usefulness}\n---\n${body}`;
    await writeFile(join(repo, "Runtime.md"), note("0.2", "we use bun\n"));
    await run(["add", "."]);
    await run(["commit", "-q", "-m", "base"]);
    await run(["checkout", "-q", "-b", "beta"]);
    await writeFile(join(repo, "Runtime.md"), note("0.3", "we use bun\nbeta appended\n"));
    await run(["commit", "-q", "-am", "beta"]);
    await run(["checkout", "-q", "main"]);
    await writeFile(join(repo, "Runtime.md"), note("0.5", "we use bun\nalpha appended\n"));
    await run(["commit", "-q", "-am", "alpha"]);
    await run(["merge", "-q", "--no-edit", "beta"]);
    expect(await readFile(join(repo, "Runtime.md"), "utf8")).toBe(
      note("0.5", "we use bun\nalpha appended\nbeta appended\n"),
    );
  }, 60_000);
});

function exec(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${command} ${args.join(" ")} failed: ${stderr || code}`));
    });
  });
}

async function which(command: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  return exec(probe, [command], process.cwd()).then(
    () => true,
    () => false,
  );
}
