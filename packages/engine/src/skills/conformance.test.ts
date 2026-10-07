import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "../extensions/skills.ts";
import { parseDocument } from "../memory/frontmatter.ts";
import { authorOf, claimAgentAuthored } from "./authorship.ts";
import { skillDescriptionFor, skillNameFor } from "./genesis.ts";
import { SkillLibrary } from "./library.ts";

const scratch = scratchDirs("keywork-skill-conformance-");

const specKeys = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const specName = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function specViolations(file: string, raw: string): string[] {
  const { frontmatter } = parseDocument(raw, file);
  const violations = Object.keys(frontmatter)
    .filter((key) => !specKeys.has(key))
    .map((key) => `unknown key ${key}`);
  const { name, description, compatibility, metadata } = frontmatter;
  if (typeof name !== "string" || name.length > 64 || !specName.test(name))
    violations.push(`bad name ${String(name)}`);
  if (name !== basename(dirname(file))) violations.push("name differs from its directory");
  if (typeof description !== "string" || description.length < 1 || description.length > 1024)
    violations.push("bad description");
  if (
    compatibility !== undefined &&
    (typeof compatibility !== "string" || compatibility.length > 500)
  )
    violations.push("bad compatibility");
  if (
    metadata !== undefined &&
    (typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      Object.values(metadata).some((value) => typeof value !== "string"))
  )
    violations.push("metadata is not a string map");
  return violations;
}

async function seed(root: string, convention: string, name: string, raw: string): Promise<string> {
  const dir = join(root, convention, name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  await writeFile(file, raw, "utf8");
  return file;
}

async function libraryAt(root: string): Promise<SkillLibrary> {
  const { skills } = await discoverSkills({ projectRoot: root });
  return new SkillLibrary({
    skills,
    genesis: { root, source: "project", convention: ".keywork/skills" },
  });
}

describe("skills keywork writes conform to the Agent Skills spec", () => {
  it("creates a conforming SKILL.md with the author under metadata", async () => {
    const root = await scratch();
    const skill = await (await libraryAt(root)).create("release-tag", "Tag a release", "Bump.");
    const raw = await readFile(skill.file, "utf8");
    expect(specViolations(skill.file, raw)).toEqual([]);
    expect(parseDocument(raw, skill.file).frontmatter.metadata).toEqual({ authored_by: "keywork" });
  });

  it("migrates a legacy top-level author under metadata on the next revision", async () => {
    const root = await scratch();
    const legacy =
      '---\nname: build\ndescription: "Build it"\nauthored_by: keywork\n---\nRun make.\n';
    const file = await seed(root, ".keywork/skills", "build", legacy);
    expect(specViolations(file, legacy)).toEqual(["unknown key authored_by"]);
    const library = await libraryAt(root);
    expect(library.find("build").authoredBy).toBe("keywork");

    await library.patch("build", "Run make.", "Run make all.");

    const raw = await readFile(file, "utf8");
    expect(specViolations(file, raw)).toEqual([]);
    expect(authorOf(parseDocument(raw, file).frontmatter)).toBe("keywork");
  });

  it("keeps a person's own metadata beside the author", async () => {
    const root = await scratch();
    const file = await seed(
      root,
      ".agents/skills",
      "lint",
      '---\nname: lint\ndescription: Lint it\nmetadata:\n  version: "1.0"\n  authored_by: keywork/linter\n---\nLint.\n',
    );
    const claimed = await claimAgentAuthored(file);
    expect(claimed.author).toBe("keywork/linter");

    await (await libraryAt(root)).rewrite("lint", "Lint twice.", "Lint everything");

    const raw = await readFile(file, "utf8");
    expect(specViolations(file, raw)).toEqual([]);
    expect(parseDocument(raw, file).frontmatter.metadata).toEqual({
      version: "1.0",
      authored_by: "keywork/linter",
    });
  });

  it("rejects names and descriptions outside the spec", async () => {
    const library = await libraryAt(await scratch());
    for (const name of ["Release_Tag", "a--b", "-a", "a-", "", "x".repeat(65), "../escape"]) {
      await expect(library.create(name, "d", "b")).rejects.toThrow(/invalid skill name/);
    }
    await expect(library.create("ok", "x".repeat(1025), "b")).rejects.toThrow(/1 to 1024/);
    await expect(library.create("ok", "  ", "b")).rejects.toThrow(/1 to 1024/);
  });

  it("names and describes genesis proposals to the spec", async () => {
    const root = await scratch();
    const library = await libraryAt(root);
    const sequences = [
      ["bun run test:unit --Watch", "bun run check"],
      ["Make_Release V2.0", "git push"],
      ["./~", "x"],
      [`${"long".repeat(40)} arg`, "y"],
    ];
    for (const commands of sequences) {
      const name = skillNameFor({ fingerprint: "abcdef0123456789", commands });
      const description = skillDescriptionFor({ commands: commands.join("\n"), occurrences: 2 });
      const skill = await library.create(name, description, "Steps.");
      expect(specViolations(skill.file, await readFile(skill.file, "utf8"))).toEqual([]);
    }
    expect(
      skillDescriptionFor({ commands: `${"x".repeat(2000)}\ny`, occurrences: 2 }),
    ).toHaveLength(1024);
  });
});

describe("Agent Skills discovery", () => {
  it("scans .agents/skills at project and user level and reads spec frontmatter leniently", async () => {
    const project = await scratch();
    const user = await scratch();
    await seed(
      project,
      ".agents/skills",
      "pdf-processing",
      '---\nname: pdf-processing\ndescription: Handle PDFs\nlicense: Apache-2.0\nallowed-tools: Bash(git:*) Read\nmetadata:\n  author: example-org\n  version: "1.0"\nx-unknown: kept quiet\n---\nPDF steps.\n',
    );
    await seed(
      user,
      ".agents/skills",
      "notes",
      "---\nname: notes\ndescription: Take notes\n---\nNote.\n",
    );

    const { skills, failures } = await discoverSkills({ projectRoot: project, userRoot: user });

    expect(failures).toEqual([]);
    expect(skills.map((skill) => [skill.name, skill.convention, skill.source])).toEqual([
      ["pdf-processing", ".agents/skills", "project"],
      ["notes", ".agents/skills", "user"],
    ]);
    expect(skills[0]).toMatchObject({ description: "Handle PDFs", authoredBy: undefined });
  });
});
