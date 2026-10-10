import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { skillTelemetryFile, workspaceIdentity } from "./paths.ts";
import { type SkillsRoots, skillArchiveRoot, skillsCommand } from "./skills-command.ts";

const scratch = scratchDirs("keywork-cli-skills-");

const agentSkill = [
  "---",
  'description: "Build the thing"',
  "metadata:",
  "  authored_by: keywork",
  "---",
  "Run `make build`.",
  "",
].join("\n");

const humanSkill = ["---", "description: Hand-written", "---", "Run `make build`.", ""].join("\n");

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

async function rootsOf(): Promise<SkillsRoots> {
  return { cwd: await scratch(), projectTrusted: true, userRoot: await scratch() };
}

async function seed(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, ".keywork", "skills", name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  await writeFile(file, content, "utf8");
  return file;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("keywork skills", () => {
  it("pins, archives only with --apply, shows history, and restores a version", async () => {
    const roots = await rootsOf();
    const file = await seed(roots.cwd, "build", agentSkill);
    const io = recorder();

    expect(await skillsCommand(["history", "build"], roots, io)).toBe(0);
    expect(io.out).toEqual(["no history for build yet"]);

    expect(await skillsCommand(["pin", "build"], roots, io)).toBe(0);
    expect(await readFile(file, "utf8")).toContain('pinned: "true"');
    expect(await skillsCommand(["archive", "build", "--apply"], roots, io, { apply: true })).toBe(
      2,
    );
    expect(io.err.at(-1)).toBe(
      'keywork skills: skill "build" is pinned; unpin it before archiving',
    );
    expect(await skillsCommand(["unpin", "build"], roots, io)).toBe(0);

    expect(await skillsCommand(["archive", "build"], roots, io)).toBe(0);
    expect(io.out.at(-1)).toBe("would archive build · --apply does it");
    expect(await exists(file)).toBe(true);

    expect(await skillsCommand(["archive", "build"], roots, io, { apply: true })).toBe(0);
    expect(await exists(file)).toBe(false);
    const stamp = io.out.at(-1)?.match(/version (\S+) ·/)?.[1];
    expect(stamp).toBeDefined();
    expect(await exists(join(skillArchiveRoot(roots.cwd), "build", stamp ?? "", "SKILL.md"))).toBe(
      true,
    );

    io.out.length = 0;
    expect(await skillsCommand(["history", "build"], roots, io)).toBe(0);
    expect(io.out.slice(0, 3).map((line) => line.split(" ").slice(1, 4).join(" "))).toEqual([
      "user pin build",
      "user unpin build",
      "user archive build",
    ]);
    expect(io.out[2]).toContain(`version ${stamp}`);
    expect(io.out[3]).toBe("archived versions:");
    expect(io.out.slice(4)).toHaveLength(3);
    expect(io.out.at(-1)).toBe(`  version ${stamp}`);

    expect(await skillsCommand(["history", "build"], roots, io, { restore: stamp })).toBe(0);
    expect(io.out.at(-1)).toBe(`restored build from version ${stamp}`);
    const restored = await readFile(file, "utf8");
    expect(restored).toContain("Run `make build`.");
    expect(restored).toContain('authored_by: "keywork"');
    expect(restored).not.toContain("pinned");
  });

  it("curates idle agent skills from telemetry, dry run first", async () => {
    const roots = await rootsOf();
    const old = await seed(roots.cwd, "old", agentSkill);
    await seed(roots.cwd, "hand", humanSkill);
    const telemetry = skillTelemetryFile(workspaceIdentity(roots.cwd), roots.userRoot);
    await mkdir(join(telemetry, ".."), { recursive: true });
    const idle = {
      counts: { use: 0, view: 1, reference: 0, patch: 0, rewrite: 0, create: 1 },
      lastActivityAt: "2020-01-01T00:00:00.000Z",
    };
    await writeFile(telemetry, JSON.stringify({ old: idle, hand: idle }), "utf8");
    const io = recorder();
    expect(await skillsCommand(["curate"], roots, io)).toBe(0);
    expect(io.out[0]).toMatch(/^- old · unused for \d+ days$/);
    expect(io.out.slice(1)).toEqual([
      "would archive old · --apply does it",
      "dry run · --apply archives these",
    ]);
    expect(await exists(old)).toBe(true);
    expect(await skillsCommand(["curate"], roots, io, { apply: true })).toBe(0);
    expect(await exists(old)).toBe(false);
    expect(await exists(join(roots.cwd, ".keywork", "skills", "hand", "SKILL.md"))).toBe(true);
  });

  it("refuses human-authored skills, unknown names, and bad usage", async () => {
    const roots = await rootsOf();
    await seed(roots.cwd, "hand", humanSkill);
    const io = recorder();
    expect(await skillsCommand(["pin", "hand"], roots, io)).toBe(2);
    expect(io.err.at(-1)).toContain("a person owns this one");
    expect(await skillsCommand(["pin"], roots, io)).toBe(2);
    expect(io.err.at(-1)).toBe("keywork skills: a skill name is required");
    expect(await skillsCommand(["archive", "nope"], roots, io)).toBe(2);
    expect(io.err.at(-1)).toContain('unknown skill "nope"');
    expect(await skillsCommand(["bogus"], roots, io)).toBe(2);
    expect(await skillsCommand([], roots, io)).toBe(2);
    expect(io.err.at(-1)).toContain("usage: keywork skills history <name>");
    expect(await skillsCommand(["history", "hand"], { ...roots, projectTrusted: false }, io)).toBe(
      2,
    );
    expect(io.err.at(-1)).toContain("no skill archive here");
  });
});
