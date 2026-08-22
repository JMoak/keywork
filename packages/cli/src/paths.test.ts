import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@keywork/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultSessionDir,
  ensureStateLayout,
  projectKey,
  StateLayoutError,
  snapshotGitDir,
  stateLayoutVersion,
  workspaceIdentity,
  workspaceStateFile,
} from "./paths.ts";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-paths-"));
  tempDirs.push(dir);
  return dir;
}

async function declareWorkspace(root: string, declaration: object): Promise<void> {
  await mkdir(join(root, ".keywork"), { recursive: true });
  await writeFile(join(root, ".keywork", "workspace.json"), JSON.stringify(declaration));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspaceIdentity", () => {
  it("falls back to the exact cwd hash for an undeclared cwd", async () => {
    const cwd = await tempRoot();
    const cwdHash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);

    expect(workspaceIdentity(cwd)).toBe(cwdHash);
    expect(workspaceIdentity(cwd)).toBe(projectKey(cwd));
  });

  it("keys a declared workspace off its root, identically from every subdirectory", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha" });
    const nested = join(root, "packages", "deep");
    await mkdir(nested, { recursive: true });

    expect(workspaceIdentity(nested)).toBe(workspaceIdentity(root));
    expect(workspaceIdentity(nested)).not.toBe(projectKey(nested));
  });

  it("keeps declared identity distinct from the undeclared hash of the same root", async () => {
    const root = await tempRoot();
    const undeclared = workspaceIdentity(root);
    await declareWorkspace(root, { name: "alpha" });

    expect(workspaceIdentity(root)).not.toBe(undeclared);
  });

  it("derives identity deterministically from the root path alone", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha" });
    const before = workspaceIdentity(root);
    await declareWorkspace(root, { name: "renamed" });

    expect(workspaceIdentity(root)).toBe(before);
  });

  it("surfaces an invalid declaration as a hard ConfigError", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".keywork"), { recursive: true });
    await writeFile(join(root, ".keywork", "workspace.json"), "{ not json");

    expect(() => workspaceIdentity(root)).toThrow(ConfigError);
  });
});

describe("workspaceIdentity for named workspaces (PD10)", () => {
  it("partitions a named workspace from the default over the same root", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha" });
    const nested = join(root, "packages", "deep");
    await mkdir(nested, { recursive: true });

    const named = workspaceIdentity(root, "frontend");
    expect(named).not.toBe(workspaceIdentity(root));
    expect(named).toBe(workspaceIdentity(nested, "frontend"));
    expect(named).not.toBe(workspaceIdentity(root, "infra"));
    expect(named).toBe(
      createHash("sha256").update(`workspace:${root}:frontend`).digest("hex").slice(0, 12),
    );
  });

  it("keeps the default identity byte-identical when named workspaces exist", async () => {
    const root = await tempRoot();
    await declareWorkspace(root, { name: "alpha" });
    const before = workspaceIdentity(root);
    await mkdir(join(root, ".keywork", "workspaces", "frontend"), { recursive: true });
    expect(workspaceIdentity(root)).toBe(before);
    expect(defaultSessionDir(root, "frontend")).toBe(
      join(homedir(), ".keywork", "sessions", workspaceIdentity(root, "frontend")),
    );
    expect(snapshotGitDir(root, "frontend")).toBe(
      join(homedir(), ".keywork", "snapshots", workspaceIdentity(root, "frontend")),
    );
  });
});

describe("workspaceStateFile", () => {
  it("keeps the state file location keyed by identity", () => {
    expect(workspaceStateFile("abc123")).toBe(
      join(homedir(), ".keywork", "workspaces", "abc123.json"),
    );
  });
});

describe("workspaceIdentity in a git repo", () => {
  async function gitRepo(): Promise<string> {
    const root = await tempRoot();
    await mkdir(join(root, ".git"), { recursive: true });
    return root;
  }

  it("keys every subdirectory of a repo off the repo root", async () => {
    const root = await gitRepo();
    const nested = join(root, "packages", "deep");
    await mkdir(nested, { recursive: true });

    expect(workspaceIdentity(nested)).toBe(workspaceIdentity(root));
    expect(workspaceIdentity(nested)).not.toBe(projectKey(nested));
  });

  it("keeps the same identity before and after the workspace materializes", async () => {
    const root = await gitRepo();
    const anchored = workspaceIdentity(root);
    await declareWorkspace(root, { name: "alpha" });

    expect(workspaceIdentity(root)).toBe(anchored);
  });
});

describe("state directories", () => {
  it("keys sessions and snapshots by workspace identity", async () => {
    const cwd = await tempRoot();
    const identity = workspaceIdentity(cwd);

    expect(defaultSessionDir(cwd)).toBe(join(homedir(), ".keywork", "sessions", identity));
    expect(snapshotGitDir(cwd)).toBe(join(homedir(), ".keywork", "snapshots", identity));
  });
});

describe("ensureStateLayout", () => {
  async function stateHome(): Promise<string> {
    return tempRoot();
  }

  function markerOf(home: string): number {
    return (
      JSON.parse(readFileSync(join(home, "state-layout.json"), "utf8")) as { version: number }
    ).version;
  }

  it("stamps a fresh state home with the current version", async () => {
    const home = await stateHome();

    expect(ensureStateLayout(home)).toBe(stateLayoutVersion);
    expect(markerOf(home)).toBe(stateLayoutVersion);
  });

  it("leaves a current state home untouched", async () => {
    const home = await stateHome();
    ensureStateLayout(home);

    expect(ensureStateLayout(home)).toBe(stateLayoutVersion);
    expect(markerOf(home)).toBe(stateLayoutVersion);
  });

  it("runs pending migrations in order, exactly once", async () => {
    const home = await stateHome();
    await writeFile(join(home, "state-layout.json"), JSON.stringify({ version: 1 }));
    const ran: number[] = [];
    const migrations = [
      { from: 2, migrate: () => ran.push(2) },
      { from: 1, migrate: () => ran.push(1) },
    ];

    expect(ensureStateLayout(home, migrations, 3)).toBe(3);
    expect(ran).toEqual([1, 2]);
    expect(markerOf(home)).toBe(3);

    ensureStateLayout(home, migrations, 3);
    expect(ran).toEqual([1, 2]);
  });

  it("refuses a state home stamped by a newer keywork", async () => {
    const home = await stateHome();
    await writeFile(join(home, "state-layout.json"), JSON.stringify({ version: 99 }));

    expect(() => ensureStateLayout(home)).toThrow(StateLayoutError);
  });
});
