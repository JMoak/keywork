import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@keywork/shared";
import { afterEach, describe, expect, it } from "vitest";
import { projectKey, workspaceIdentity, workspaceStateFile } from "./paths.ts";

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

describe("workspaceStateFile", () => {
  it("keeps the state file location keyed by identity", () => {
    expect(workspaceStateFile("abc123")).toBe(
      join(homedir(), ".keywork", "workspaces", "abc123.json"),
    );
  });
});
