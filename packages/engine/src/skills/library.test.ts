import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "../extensions/skills.ts";
import { ProtectedSkillError } from "./authorship.ts";
import {
  ReferenceOutsideSkillError,
  type SkillChange,
  SkillGenesisUnavailableError,
  SkillLibrary,
  SkillPatchError,
  UnknownSkillError,
} from "./library.ts";
import { SkillTelemetry } from "./telemetry.ts";

const scratch = scratchDirs("keywork-skill-library-");

const agentSkill = [
  "---",
  'description: "Build the thing"',
  "authored_by: keywork",
  "---",
  "Run `make build-old` and check the output.",
  "",
].join("\n");

const humanSkill = ["---", "description: Hand-written", "---", "Run `make build-old`.", ""].join(
  "\n",
);

async function seed(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, ".keywork", "skills", name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  await writeFile(file, content, "utf8");
  return file;
}

async function libraryAt(root: string, changes: SkillChange[] = []) {
  const { skills } = await discoverSkills({ projectRoot: root });
  const telemetry = new SkillTelemetry({ clock: () => new Date("2026-09-06T10:00:00Z") });
  const library = new SkillLibrary({
    skills,
    telemetry,
    genesis: { root, source: "project", convention: ".keywork/skills" },
    onChange: (change) => changes.push(change),
  });
  return { library, telemetry };
}

describe("SkillLibrary patching", () => {
  it("patches an agent-authored skill on disk and in memory, keeping the marker", async () => {
    const root = await scratch();
    const file = await seed(root, "build", agentSkill);
    const changes: SkillChange[] = [];
    const { library, telemetry } = await libraryAt(root, changes);

    const patched = await library.patch("build", "make build-old", "make build-new");

    expect(patched.body).toBe("Run `make build-new` and check the output.");
    expect(library.find("build").body).toContain("make build-new");
    const onDisk = await readFile(file, "utf8");
    expect(onDisk).toContain('authored_by: "keywork"');
    expect(onDisk).toContain("make build-new");
    expect(onDisk).not.toContain("make build-old");
    const rediscovered = await discoverSkills({ projectRoot: root });
    expect(rediscovered.skills[0]?.body).toBe(patched.body);
    expect(rediscovered.skills[0]?.authoredBy).toBe("keywork");
    expect(telemetry.activityOf("build").counts.patch).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("patch");
    expect(changes[0]?.delta.before).toBe(agentSkill);
    expect(changes[0]?.delta.after).toBe(onDisk);
  });

  it("refuses to touch a human-authored skill and leaves it byte-identical", async () => {
    const root = await scratch();
    const file = await seed(root, "manual", humanSkill);
    const changes: SkillChange[] = [];
    const { library, telemetry } = await libraryAt(root, changes);

    await expect(library.patch("manual", "make build-old", "make build-new")).rejects.toThrow(
      ProtectedSkillError,
    );
    await expect(library.rewrite("manual", "anything")).rejects.toThrow(ProtectedSkillError);

    expect(await readFile(file, "utf8")).toBe(humanSkill);
    expect(library.find("manual").body).toBe("Run `make build-old`.");
    expect(telemetry.activityOf("manual").counts.patch).toBe(0);
    expect(changes).toEqual([]);
  });

  it("checks authorship on disk at patch time, not from the discovery snapshot", async () => {
    const root = await scratch();
    const file = await seed(root, "build", agentSkill);
    const { library } = await libraryAt(root);
    await writeFile(file, humanSkill, "utf8");

    await expect(library.patch("build", "make build-old", "make build-new")).rejects.toThrow(
      ProtectedSkillError,
    );
    expect(await readFile(file, "utf8")).toBe(humanSkill);
  });

  it("demands a unique match and points at rewrite otherwise", async () => {
    const root = await scratch();
    await seed(root, "build", agentSkill);
    const { library } = await libraryAt(root);

    await expect(library.patch("build", "nope", "x")).rejects.toThrow(SkillPatchError);
    await expect(library.patch("build", "e", "x")).rejects.toThrow(/matches \d+ places/);
    await expect(library.patch("missing", "a", "b")).rejects.toThrow(UnknownSkillError);
  });

  it("rewrites the body and description as the fallback", async () => {
    const root = await scratch();
    const file = await seed(root, "build", agentSkill);
    const { library, telemetry } = await libraryAt(root);

    const rewritten = await library.rewrite("build", "Fresh steps.", "Build it right");

    expect(rewritten).toMatchObject({ body: "Fresh steps.", description: "Build it right" });
    const onDisk = await readFile(file, "utf8");
    expect(onDisk).toBe(
      '---\ndescription: "Build it right"\nauthored_by: "keywork"\n---\nFresh steps.\n',
    );
    expect(telemetry.activityOf("build").counts.rewrite).toBe(1);
  });
});

describe("SkillLibrary genesis", () => {
  it("creates a marked skill under the genesis root and registers it live", async () => {
    const root = await scratch();
    const changes: SkillChange[] = [];
    const { library, telemetry } = await libraryAt(root, changes);

    const created = await library.create("release-tag", "Tag a release", "1. Bump.\n2. Tag.");

    expect(created.file).toBe(join(root, ".keywork", "skills", "release-tag", "SKILL.md"));
    expect(created.authoredBy).toBe("keywork");
    expect(library.skills().map((skill) => skill.name)).toEqual(["release-tag"]);
    const { skills } = await discoverSkills({ projectRoot: root });
    expect(skills[0]).toMatchObject({
      name: "release-tag",
      description: "Tag a release",
      body: "1. Bump.\n2. Tag.",
      authoredBy: "keywork",
    });
    expect(telemetry.activityOf("release-tag").counts.create).toBe(1);
    expect(changes[0]?.delta.before).toBeNull();
    await expect(library.patch("release-tag", "Bump.", "Bump version.")).resolves.toMatchObject({
      body: "1. Bump version.\n2. Tag.",
    });
  });

  it("never overwrites an existing skill or accepts a hostile name", async () => {
    const root = await scratch();
    await seed(root, "manual", humanSkill);
    const { library } = await libraryAt(root);

    await expect(library.create("manual", "d", "b")).rejects.toThrow(/already exists/);
    await expect(library.create("../escape", "d", "b")).rejects.toThrow(/invalid name/);
    expect(await readFile(join(root, ".keywork", "skills", "manual", "SKILL.md"), "utf8")).toBe(
      humanSkill,
    );
  });

  it("cannot create without a genesis root", async () => {
    const library = new SkillLibrary({ skills: [] });
    expect(library.canCreate()).toBe(false);
    await expect(library.create("x", "d", "b")).rejects.toThrow(SkillGenesisUnavailableError);
  });
});

describe("SkillLibrary progressive disclosure", () => {
  it("views a skill with its reference files and reads one, confined to the skill dir", async () => {
    const root = await scratch();
    await seed(root, "build", agentSkill);
    const dir = join(root, ".keywork", "skills", "build");
    await mkdir(join(dir, "references"), { recursive: true });
    await writeFile(join(dir, "references", "flags.md"), "All the flags.", "utf8");
    await writeFile(join(root, "secret.txt"), "nope", "utf8");
    const { library, telemetry } = await libraryAt(root);

    const view = await library.view("build");
    expect(view.files).toEqual(["references/flags.md"]);
    await expect(library.reference("build", "references/flags.md")).resolves.toBe("All the flags.");
    await expect(library.reference("build", "../../../secret.txt")).rejects.toThrow(
      ReferenceOutsideSkillError,
    );
    await expect(library.reference("build", ".")).rejects.toThrow(ReferenceOutsideSkillError);
    const counts = telemetry.activityOf("build").counts;
    expect([counts.view, counts.reference, counts.use]).toEqual([1, 1, 0]);
    await library.use("build");
    expect(telemetry.activityOf("build").counts.use).toBe(1);
  });
});
