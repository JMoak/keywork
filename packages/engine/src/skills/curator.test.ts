import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "../extensions/skills.ts";
import { Gardener } from "../memory/gardener.ts";
import { MemoryStore } from "../memory/store.ts";
import { ProtectedSkillError } from "./authorship.ts";
import {
  archiveCandidates,
  isPinned,
  SkillArchive,
  SkillVersionNotFoundError,
  skillArchiveDirName,
  userActor,
} from "./curator.ts";
import { PinnedSkillError, type SkillChange, SkillLibrary } from "./library.ts";
import { SkillTelemetry, type SkillTelemetrySnapshot } from "./telemetry.ts";

const scratch = scratchDirs("keywork-skill-curator-");

const agentSkill = [
  "---",
  'description: "Build the thing"',
  "metadata:",
  "  authored_by: keywork",
  "---",
  "Run `make build-old` and check the output.",
  "",
].join("\n");

const humanSkill = ["---", "description: Hand-written", "---", "Run `make build-old`.", ""].join(
  "\n",
);

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 7, 9, 0, tick++));

async function seed(root: string, name: string, content: string, extra?: string): Promise<string> {
  const dir = join(root, ".keywork", "skills", name);
  await mkdir(join(dir, "references"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf8");
  if (extra !== undefined) await writeFile(join(dir, "references", "notes.md"), extra, "utf8");
  return join(dir, "SKILL.md");
}

async function libraryAt(root: string, changes: SkillChange[] = []) {
  const { skills } = await discoverSkills({ projectRoot: root });
  const archive = new SkillArchive({
    root: join(root, ".keywork", skillArchiveDirName),
    now: clock,
  });
  const telemetry = new SkillTelemetry({ clock });
  const library = new SkillLibrary({
    skills,
    telemetry,
    archive,
    genesis: { root, source: "project", convention: ".keywork/skills" },
    onChange: (change) => changes.push(change),
  });
  return { library, archive, telemetry };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("archive instead of deletion", () => {
  it("moves the whole skill directory into a versioned archive and records the actor", async () => {
    const root = await scratch();
    const file = await seed(root, "build", agentSkill, "reference text");
    const changes: SkillChange[] = [];
    const { library, archive } = await libraryAt(root, changes);

    const dry = await library.archive("build", userActor, true);
    expect(dry).toEqual({ name: "build", dryRun: true });
    expect(await exists(file)).toBe(true);
    expect(await archive.history("build")).toEqual([]);

    const outcome = await library.archive("build", userActor);
    expect(outcome.dryRun).toBe(false);
    expect(await exists(file)).toBe(false);
    expect(library.skills()).toEqual([]);
    const version = outcome.version;
    if (version === undefined) throw new Error("expected a version");
    expect(await readFile(version.file, "utf8")).toBe(agentSkill);
    expect(await readFile(join(version.dir, "references", "notes.md"), "utf8")).toBe(
      "reference text",
    );
    expect(await archive.history("build")).toEqual([
      {
        at: expect.any(String),
        actor: "user",
        action: "archive",
        skill: "build",
        version: version.stamp,
      },
    ]);
    expect(changes.map((change) => change.kind)).toEqual(["archive"]);
    expect(changes[0]?.delta.after).toBeNull();
    const rediscovered = await discoverSkills({ projectRoot: root });
    expect(rediscovered.skills).toEqual([]);
  });

  it("never archives a human-authored skill", async () => {
    const root = await scratch();
    const file = await seed(root, "hand", humanSkill);
    const { library } = await libraryAt(root);
    await expect(library.archive("hand", "curator")).rejects.toBeInstanceOf(ProtectedSkillError);
    expect(await readFile(file, "utf8")).toBe(humanSkill);
  });
});

describe("pin", () => {
  it("exempts a skill from curation and from archiving until unpinned", async () => {
    const root = await scratch();
    const file = await seed(root, "build", agentSkill);
    const { library, archive } = await libraryAt(root);
    await library.pin("build", userActor);
    const raw = await readFile(file, "utf8");
    expect(raw).toContain('pinned: "true"');
    expect(raw).toContain('authored_by: "keywork"');
    expect(await library.evidence()).toEqual([
      { name: "build", authoredBy: "keywork", pinned: true },
    ]);
    await expect(library.archive("build", "curator")).rejects.toBeInstanceOf(PinnedSkillError);

    const idle: SkillTelemetrySnapshot = {
      build: {
        counts: { use: 0, view: 0, reference: 0, patch: 0, rewrite: 0, create: 1 },
        lastActivityAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const store = new MemoryStore({ vaultRoot: await scratch(), trusted: true, now: clock });
    const gardener = new Gardener({ store, now: clock });
    const report = await gardener.sweep({
      skills: { skills: await library.evidence(), telemetry: idle },
    });
    expect(report.flagged).toEqual([]);
    expect(archiveCandidates(await library.evidence(), idle, clock())).toEqual([]);

    await library.unpin("build", userActor);
    expect(isPinned({ metadata: { authored_by: "keywork" } })).toBe(false);
    expect(await library.evidence()).toEqual([
      { name: "build", authoredBy: "keywork", pinned: false },
    ]);
    expect(archiveCandidates(await library.evidence(), idle, clock())).toEqual([
      { name: "build", idleDays: expect.any(Number), uses: 0 },
    ]);
    expect((await archive.history("build")).map((entry) => entry.action)).toEqual(["pin", "unpin"]);
  });
});

describe("curate", () => {
  it("dry runs by default and only archives idle unpinned agent skills when applied", async () => {
    const root = await scratch();
    await seed(root, "old", agentSkill);
    await seed(root, "fresh", agentSkill);
    await seed(root, "hand", humanSkill);
    const { library } = await libraryAt(root);
    const telemetry: SkillTelemetrySnapshot = {
      old: {
        counts: { use: 0, view: 2, reference: 0, patch: 0, rewrite: 0, create: 1 },
        lastActivityAt: "2026-08-01T00:00:00.000Z",
      },
      fresh: {
        counts: { use: 0, view: 0, reference: 0, patch: 0, rewrite: 0, create: 1 },
        lastActivityAt: "2026-10-06T00:00:00.000Z",
      },
      hand: {
        counts: { use: 0, view: 0, reference: 0, patch: 0, rewrite: 0, create: 0 },
        lastActivityAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const dry = await library.curate({ telemetry, now: clock() });
    expect(dry.dryRun).toBe(true);
    expect(dry.candidates.map((candidate) => candidate.name)).toEqual(["old"]);
    expect(
      library
        .skills()
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(["fresh", "hand", "old"]);

    const applied = await library.curate({ telemetry, now: clock(), dryRun: false });
    expect(applied.archived.map((outcome) => outcome.name)).toEqual(["old"]);
    expect(
      library
        .skills()
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(["fresh", "hand"]);
    expect((await library.history("old")).entries[0]).toMatchObject({
      actor: "curator",
      action: "archive",
    });
  });
});

describe("history and restore", () => {
  it("keeps every prior version in the archive and restores one on request", async () => {
    const root = await scratch();
    const file = await seed(root, "build", agentSkill);
    const changes: SkillChange[] = [];
    const { library } = await libraryAt(root, changes);
    await library.patch("build", "make build-old", "make build");
    await library.rewrite("build", "Run `make all`.\n");
    const history = await library.history("build");
    expect(history.entries.map((entry) => [entry.actor, entry.action])).toEqual([
      ["agent", "patch"],
      ["agent", "rewrite"],
    ]);
    expect(history.versions).toHaveLength(2);
    const [original, patched] = history.versions;
    if (original === undefined || patched === undefined) throw new Error("expected versions");
    expect(await readFile(original.file, "utf8")).toBe(agentSkill);
    expect(await readFile(patched.file, "utf8")).toContain("make build`");
    expect(history.entries[0]?.version).toBe(original.stamp);

    const restored = await library.restore("build", original.stamp, userActor);
    expect(restored.body).toBe("Run `make build-old` and check the output.");
    expect(await readFile(file, "utf8")).toBe(agentSkill);
    expect(library.find("build").body).toBe(restored.body);
    const after = await library.history("build");
    expect(after.entries.at(-1)).toMatchObject({
      actor: "user",
      action: "restore",
      version: original.stamp,
    });
    expect(after.versions).toHaveLength(3);
    expect(changes.map((change) => change.kind)).toEqual(["patch", "rewrite", "restore"]);
  });

  it("restores an archived skill back into the genesis root", async () => {
    const root = await scratch();
    await seed(root, "build", agentSkill);
    const { library } = await libraryAt(root);
    const archived = await library.archive("build", userActor);
    const stamp = archived.version?.stamp ?? "";
    await expect(library.restore("build", "nope", userActor)).rejects.toBeInstanceOf(
      SkillVersionNotFoundError,
    );
    const restored = await library.restore("build", stamp, userActor);
    expect(restored.file).toBe(join(root, ".keywork", "skills", "build", "SKILL.md"));
    expect(restored.authoredBy).toBe("keywork");
    expect((await discoverSkills({ projectRoot: root })).skills.map((skill) => skill.name)).toEqual(
      ["build"],
    );
    expect(await readdir(join(root, ".keywork", skillArchiveDirName, "build"))).toEqual([stamp]);
  });
});
