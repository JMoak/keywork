import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaces, openWorkspace } from "@keywork/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileWorkspaceRecall,
  nameFromSlug,
  selectWorkspace,
  type WorkspaceRecall,
  workspaceCommand,
  workspacesPort,
} from "./workspaces.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-workspaces-"));
  tempDirs.push(dir);
  return dir;
}

async function declaredRoot(): Promise<string> {
  const root = await tempDir();
  await mkdir(join(root, ".keywork", "memory"), { recursive: true });
  await writeFile(join(root, ".keywork", "workspace.json"), JSON.stringify({ name: "alpha" }));
  return root;
}

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

async function recallIn(dir: string): Promise<WorkspaceRecall> {
  return fileWorkspaceRecall(join(dir, "state", "workspace-mru.json"));
}

describe("workspace recall (per launch subpath MRU)", () => {
  it("remembers the slug per cwd and treats the default as an empty entry", async () => {
    const root = await tempDir();
    const recall = await recallIn(root);
    expect(recall.recall(root)).toBeUndefined();
    recall.remember(root, "frontend");
    expect(recall.recall(root)).toBe("frontend");
    recall.remember(root, undefined);
    expect(recall.recall(root)).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, "state", "workspace-mru.json"), "utf8"))).toEqual({
      [Object.keys(
        JSON.parse(await readFile(join(root, "state", "workspace-mru.json"), "utf8")),
      )[0] as string]: "",
    });
  });

  it("keys different launch subpaths independently", async () => {
    const root = await tempDir();
    const nested = join(root, "web");
    await mkdir(nested, { recursive: true });
    const recall = await recallIn(root);
    recall.remember(nested, "frontend");
    expect(recall.recall(root)).toBeUndefined();
    expect(recall.recall(nested)).toBe("frontend");
  });
});

describe("selectWorkspace", () => {
  it("prefers an explicit request, then the MRU, and falls back to the default with a warning", async () => {
    const root = await declaredRoot();
    const recall = await recallIn(root);
    const warnings: string[] = [];
    const warn = (line: string) => warnings.push(line);
    await workspaceCommand(["new", "frontend"], root, consoleOf().io, undefined, recall);

    expect(selectWorkspace(root, "frontend", recall, warn)).toBe("frontend");
    recall.remember(root, "frontend");
    expect(selectWorkspace(root, undefined, recall, warn)).toBe("frontend");
    expect(selectWorkspace(root, "ghost", recall, warn)).toBeUndefined();
    expect(warnings.at(-1)).toContain('no workspace named "ghost"');
    recall.remember(root, "vanished");
    expect(selectWorkspace(root, undefined, recall, warn)).toBeUndefined();
    expect(warnings.at(-1)).toContain('last-used workspace "vanished" is gone');
  });
});

describe("keywork workspace", () => {
  it("lists the default slot and named workspaces, marking the one that opens next", async () => {
    const root = await declaredRoot();
    const recall = await recallIn(root);
    const first = consoleOf();
    expect(await workspaceCommand(["list"], root, first.io, undefined, recall)).toBe(0);
    expect(first.out[0]).toMatch(/^\* default\s+alpha\s+\.keywork[\\/]memory$/);

    await workspaceCommand(["new", "frontend-revamp"], root, consoleOf().io, undefined, recall);
    recall.remember(root, "frontend-revamp");
    const second = consoleOf();
    await workspaceCommand([], root, second.io, undefined, recall);
    expect(second.out[0]).toMatch(/^ {2}default/);
    expect(second.out[1]).toMatch(/^\* frontend-revamp\s+frontend revamp\s+/);
  });

  it("creates a named workspace with its own vault and refuses duplicates or bad slugs", async () => {
    const root = await declaredRoot();
    const recall = await recallIn(root);
    const created = consoleOf();
    expect(await workspaceCommand(["new", "infra"], root, created.io, undefined, recall)).toBe(0);
    expect(created.out[0]).toContain("workspace infra ready at");
    expect(existsSync(join(root, ".keywork", "workspaces", "infra", "memory"))).toBe(true);
    expect(openWorkspace(root, "infra")?.name).toBe("infra");

    const duplicate = consoleOf();
    expect(await workspaceCommand(["new", "infra"], root, duplicate.io, undefined, recall)).toBe(1);
    expect(duplicate.err[0]).toContain("already exists");
    const bad = consoleOf();
    expect(await workspaceCommand(["new", "Bad Slug"], root, bad.io, undefined, recall)).toBe(1);
    expect(bad.err[0]).toContain("isn't a workspace slug");
    const missing = consoleOf();
    expect(await workspaceCommand(["new"], root, missing.io, undefined, recall)).toBe(1);
  });

  it("use records the MRU for the next launch and refuses unknown names", async () => {
    const root = await declaredRoot();
    const recall = await recallIn(root);
    await workspaceCommand(["new", "infra"], root, consoleOf().io, undefined, recall);
    const used = consoleOf();
    expect(await workspaceCommand(["use", "infra"], root, used.io, undefined, recall)).toBe(0);
    expect(recall.recall(root)).toBe("infra");
    expect(await workspaceCommand(["use", "default"], root, used.io, undefined, recall)).toBe(0);
    expect(recall.recall(root)).toBeUndefined();
    const unknown = consoleOf();
    expect(await workspaceCommand(["use", "ghost"], root, unknown.io, undefined, recall)).toBe(1);
    expect(unknown.err[0]).toContain("no workspace named ghost");
  });

  it("rm removes an empty workspace outright, never the default, and forgets a stale MRU", async () => {
    const root = await declaredRoot();
    const recall = await recallIn(root);
    await workspaceCommand(["new", "infra"], root, consoleOf().io, undefined, recall);
    recall.remember(root, "infra");
    const removed = consoleOf();
    expect(await workspaceCommand(["rm", "infra"], root, removed.io, undefined, recall)).toBe(0);
    expect(listWorkspaces(root).map((slot) => slot.slug)).toEqual([undefined]);
    expect(recall.recall(root)).toBeUndefined();
    const refused = consoleOf();
    expect(await workspaceCommand(["rm", "default"], root, refused.io, undefined, recall)).toBe(1);
    expect(await workspaceCommand(["rm", "ghost"], root, refused.io, undefined, recall)).toBe(1);
  });

  it("rm of a non-empty vault demands the confirmed destructive form and never runs silently", async () => {
    const root = await declaredRoot();
    const recall = await recallIn(root);
    await workspaceCommand(["new", "infra"], root, consoleOf().io, undefined, recall);
    const vault = join(root, ".keywork", "workspaces", "infra", "memory");
    await writeFile(join(vault, "Rule.md"), "---\n---\nkeep\n");

    const headless = consoleOf();
    expect(await workspaceCommand(["rm", "infra"], root, headless.io, undefined, recall)).toBe(1);
    expect(headless.err[0]).toContain("holds 1 memory file");
    expect(existsSync(vault)).toBe(true);

    const declined = consoleOf();
    const questions: string[] = [];
    expect(
      await workspaceCommand(
        ["rm", "infra"],
        root,
        declined.io,
        async (question) => {
          questions.push(question);
          return false;
        },
        recall,
      ),
    ).toBe(1);
    expect(questions[0]).toContain("remove workspace infra and its 1 memory files?");
    expect(existsSync(vault)).toBe(true);

    const confirmed = consoleOf();
    expect(
      await workspaceCommand(["rm", "infra"], root, confirmed.io, async () => true, recall),
    ).toBe(0);
    expect(existsSync(vault)).toBe(false);
  });

  it("rejects an unknown subcommand", async () => {
    const root = await declaredRoot();
    const bad = consoleOf();
    expect(
      await workspaceCommand(["frobnicate"], root, bad.io, undefined, await recallIn(root)),
    ).toBe(1);
  });
});

describe("workspacesPort", () => {
  it("lists choices with the current marked, creates on request, and records the switch", async () => {
    const root = await declaredRoot();
    const recall = await recallIn(root);
    const switches: Array<string | undefined> = [];
    const port = workspacesPort({
      cwd: root,
      current: undefined,
      recall,
      requestSwitch: (slug) => switches.push(slug),
    });
    expect(await port.list()).toEqual([
      { slug: undefined, name: "alpha", declared: true, current: true, notes: 0 },
    ]);

    await port.create("frontend");
    expect((await port.list()).map((choice) => choice.slug)).toEqual([undefined, "frontend"]);
    await expect(port.create("frontend")).rejects.toThrow("already exists");

    await port.use("frontend");
    expect(switches).toEqual(["frontend"]);
    expect(recall.recall(root)).toBe("frontend");
    await expect(port.use("ghost")).rejects.toThrow("no workspace named ghost");
    await port.use(undefined);
    expect(recall.recall(root)).toBeUndefined();
  });
});

describe("nameFromSlug", () => {
  it("turns a slug into a readable name", () => {
    expect(nameFromSlug("frontend-revamp")).toBe("frontend revamp");
  });
});
