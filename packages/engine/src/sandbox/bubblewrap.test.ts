import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { bashTool, detectShell } from "../tools/bash.ts";
import { toolScope } from "../tools/confine.ts";
import { bubblewrapArgs, bubblewrapSandbox, confinementPlan } from "./bubblewrap.ts";
import { sandboxFor, sandboxSupport } from "./host.ts";
import type { Sandbox } from "./sandbox.ts";
import { fixedSandbox } from "./session.ts";

const tempDir = scratchDirs("keywork-bwrap-");
const launch = { file: "/bin/sh", args: ["-c", "true"], cwd: "/work", env: { TMPDIR: "/scratch" } };

async function homeWith(...dirs: string[]): Promise<string> {
  const home = await tempDir();
  for (const dir of dirs) await mkdir(join(home, dir), { recursive: true });
  return home;
}

function real(path: string): string {
  return realpathSync.native(path);
}

describe("confinementPlan", () => {
  it("lets workspace commands write the workspace and the package caches that exist", async () => {
    const home = await homeWith(".npm", ".cache", ".keywork");
    const root = await tempDir();

    const plan = confinementPlan("workspace", toolScope(root), { home, env: {} });

    expect(plan.network).toBe(true);
    expect(plan.writable).toEqual(
      expect.arrayContaining([real(root), real(join(home, ".npm")), real(join(home, ".cache"))]),
    );
    expect(plan.writable.some((path) => path.includes(".cargo"))).toBe(false);
    expect(plan.hidden).toEqual([real(join(home, ".keywork"))]);
  });

  it("follows XDG_CACHE_HOME to the cache the user actually uses", async () => {
    const home = await homeWith(".cache", "xdg-cache");
    const xdg = join(home, "xdg-cache");

    const plan = confinementPlan("workspace", toolScope(await tempDir()), {
      home,
      env: { XDG_CACHE_HOME: xdg },
    });

    expect(plan.writable).toContain(real(xdg));
    expect(plan.writable).not.toContain(real(join(home, ".cache")));
  });

  it("gives isolated commands the workspace alone and hides caches and keywork's state", async () => {
    const home = await homeWith(".npm", ".cache", ".keywork");
    const root = await tempDir();

    const plan = confinementPlan("isolated", toolScope(root), { home, env: {} });

    expect(plan.network).toBe(false);
    expect(plan.writable).toEqual([real(root)]);
    expect(plan.hidden).toEqual(
      expect.arrayContaining([real(join(home, ".cache")), real(join(home, ".keywork"))]),
    );
  });

  it("keeps a worktree's shared git dir writable so commits still land", async () => {
    const main = await tempDir();
    const worktreeGitDir = join(main, ".git", "worktrees", "feature");
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(worktreeGitDir, "commondir"), "../..\n");
    const root = await tempDir();
    await writeFile(join(root, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const plan = confinementPlan("workspace", toolScope(root), { home: await homeWith(), env: {} });

    expect(plan.writable).toContain(real(join(main, ".git")));
  });

  it("keeps a submodule's git dir writable", async () => {
    const parent = await tempDir();
    const modules = join(parent, ".git", "modules", "lib");
    await mkdir(modules, { recursive: true });
    const root = join(parent, "lib");
    await mkdir(root);
    await writeFile(join(root, ".git"), "gitdir: ../.git/modules/lib\n");

    const plan = confinementPlan("isolated", toolScope(root), { home: await homeWith(), env: {} });

    expect(plan.writable).toEqual([real(root), real(modules)]);
  });
});

describe("bubblewrapArgs", () => {
  it("mounts read-only first, then shallow paths before the deeper paths inside them", () => {
    const plan = {
      writable: ["/home/kw", "/tmp", "/home/kw/ws"],
      hidden: ["/home/kw/.keywork"],
      network: true,
    };

    expect(bubblewrapArgs(plan, launch)).toEqual([
      ...["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"],
      ...["--bind", "/tmp", "/tmp"],
      ...["--bind", "/home/kw", "/home/kw"],
      ...["--tmpfs", "/home/kw/.keywork"],
      ...["--bind", "/home/kw/ws", "/home/kw/ws"],
      ...["--unshare-pid", "--unshare-ipc", "--die-with-parent"],
      ...["--chdir", "/work", "--", "/bin/sh", "-c", "true"],
    ]);
  });

  it("re-exposes a workspace that lives under a hidden temp", () => {
    const plan = { writable: ["/tmp/ws"], hidden: ["/tmp", "/run"], network: false };

    const args = bubblewrapArgs(plan, launch);

    expect(args.indexOf("/tmp/ws")).toBeGreaterThan(args.indexOf("/tmp"));
    expect(args).toContain("--unshare-net");
  });
});

describe("bubblewrapSandbox", () => {
  it("runs the launch under bwrap and points isolated temp at its private /tmp", async () => {
    const host = { bubblewrap: "/usr/bin/bwrap", home: await homeWith(), env: {} };
    const scope = toolScope(await tempDir());

    const workspace = bubblewrapSandbox("workspace", scope, host).confine(launch);
    const isolated = bubblewrapSandbox("isolated", scope, host).confine(launch);

    expect(workspace.file).toBe("/usr/bin/bwrap");
    expect(workspace.cwd).toBe("/work");
    expect(workspace.env.TMPDIR).toBe("/scratch");
    expect(isolated.env.TMPDIR).toBe("/tmp");
  });
});

describe("bubblewrap on a real kernel", () => {
  async function honoured(
    mode: "workspace" | "isolated",
    root: string,
    skip: (condition: boolean, note: string) => void,
  ): Promise<Sandbox> {
    skip(
      process.platform !== "linux",
      `bubblewrap is linux only and this host is ${process.platform}`,
    );
    const refusal = (await sandboxSupport())[mode];
    skip(refusal !== undefined, `no working bubblewrap here: ${refusal?.message}`);
    return sandboxFor(mode, toolScope(root));
  }

  function run(root: string, sandbox: Sandbox, command: string): Promise<string> {
    return bashTool(root, detectShell(), undefined, fixedSandbox(sandbox)).execute({ command });
  }

  it("keeps workspace writes inside the workspace", async (context) => {
    const root = await tempDir();
    const sandbox = await honoured("workspace", root, context.skip);
    const outside = await mkdtemp(join(homedir(), ".keywork-sandbox-probe-"));
    try {
      await run(root, sandbox, "echo kept > inside.txt");
      const escaped = await run(root, sandbox, `echo leaked > '${join(outside, "leak.txt")}'`);

      expect(readFileSync(join(root, "inside.txt"), "utf8").trim()).toBe("kept");
      expect(existsSync(join(outside, "leak.txt"))).toBe(false);
      expect(escaped).toMatch(/read-only file system/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("gives isolated commands no network and a temp that vanishes with them", async (context) => {
    const root = await tempDir();
    const sandbox = await honoured("isolated", root, context.skip);
    const marker = `keywork-private-${randomUUID()}`;

    const devices = await run(root, sandbox, "cat /proc/net/dev");
    await run(root, sandbox, `touch /tmp/${marker} && echo kept > inside.txt`);

    expect(interfacesIn(devices)).toEqual(["lo"]);
    expect(existsSync(join("/tmp", marker))).toBe(false);
    expect(readFileSync(join(root, "inside.txt"), "utf8").trim()).toBe("kept");
  });
});

function interfacesIn(procNetDev: string): string[] {
  return procNetDev
    .split("\n")
    .map((line) => /^\s*([^\s:|]+):/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}
