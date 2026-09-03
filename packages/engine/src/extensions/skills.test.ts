import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { discoverSkills, skillTool } from "./skills.ts";

const scratch = scratchDirs("keywork-skills-");
const directoryLinksSupported = await probeDirectoryLinkSupport();

async function scratchRoot(): Promise<string> {
  const root = await scratch();
  return root;
}

async function seedSkill(root: string, relativeDir: string, content: string): Promise<void> {
  const dir = join(root, relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf8");
}

describe("discoverSkills", () => {
  it("finds project skills across .keywork, .claude, and .cursor conventions", async () => {
    const root = await scratchRoot();
    await seedSkill(
      root,
      ".keywork/skills/deploy",
      "---\ndescription: Ship it\n---\nDeploy steps.",
    );
    await seedSkill(
      root,
      ".claude/skills/review",
      "---\ndescription: Review well\n---\nReview steps.",
    );
    await seedSkill(root, ".cursor/skills/lint", "Lint steps.");
    const { skills, failures } = await discoverSkills({ projectRoot: root });
    expect(failures).toEqual([]);
    expect(skills.map((skill) => [skill.name, skill.convention, skill.source])).toEqual([
      ["deploy", ".keywork/skills", "project"],
      ["review", ".claude/skills", "project"],
      ["lint", ".cursor/skills", "project"],
    ]);
    expect(skills[0]?.dir).toBe(join(root, ".keywork", "skills", "deploy"));
    expect(skills[1]?.description).toBe("Review well");
    expect(skills[2]?.body).toBe("Lint steps.");
  });

  it("finds user-level skills under the same conventions", async () => {
    const user = await scratchRoot();
    await seedSkill(user, ".claude/skills/personal", "Mine.");
    const { skills } = await discoverSkills({ userRoot: user });
    expect(skills.map((skill) => [skill.name, skill.source])).toEqual([["personal", "user"]]);
  });

  it("lets a project skill win over a user skill with the same name", async () => {
    const project = await scratchRoot();
    const user = await scratchRoot();
    await seedSkill(project, ".cursor/skills/deploy", "project wins");
    await seedSkill(user, ".keywork/skills/deploy", "user loses");
    await seedSkill(user, ".keywork/skills/extra", "user only");
    const { skills } = await discoverSkills({ projectRoot: project, userRoot: user });
    expect(skills.map((skill) => [skill.name, skill.body, skill.source])).toEqual([
      ["deploy", "project wins", "project"],
      ["extra", "user only", "user"],
    ]);
  });

  it("prefers frontmatter names and lets .keywork win name collisions", async () => {
    const root = await scratchRoot();
    await seedSkill(root, ".keywork/skills/shipper", "---\nname: deploy\n---\nkeywork wins");
    await seedSkill(root, ".claude/skills/deploy", "claude loses");
    const { skills } = await discoverSkills({ projectRoot: root });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "deploy", body: "keywork wins" });
  });

  it("stays calm with no skills anywhere", async () => {
    const root = await scratchRoot();
    await expect(discoverSkills({ projectRoot: root, userRoot: root })).resolves.toEqual({
      skills: [],
      failures: [],
    });
  });

  it("finds nested skills and quarantines malformed ones", async () => {
    const root = await scratchRoot();
    await seedSkill(root, ".claude/skills/group/deep/thing", "Deep skill.");
    await seedSkill(root, ".claude/skills/broken", "---\nnever closed\n");
    const { skills, failures } = await discoverSkills({ projectRoot: root });
    expect(skills.map((skill) => skill.name)).toEqual(["thing"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain("frontmatter");
  });

  it.skipIf(!directoryLinksSupported)("survives symlink cycles without looping", async () => {
    const root = await scratchRoot();
    await seedSkill(root, ".keywork/skills/looped", "Looped skill.");
    await symlink(
      join(root, ".keywork", "skills"),
      join(root, ".keywork", "skills", "looped", "back"),
      "junction",
    );
    const { skills } = await discoverSkills({ projectRoot: root });
    expect(skills.map((skill) => skill.name)).toEqual(["looped"]);
  });
});

describe("skillTool", () => {
  const skills = [
    {
      name: "deploy",
      description: "Ship it",
      body: "Step one. Step two.",
      dir: "/repo/.keywork/skills/deploy",
      file: "/repo/.keywork/skills/deploy/SKILL.md",
      source: "project" as const,
      convention: ".keywork/skills",
    },
  ];

  it("lists every skill with its description in the tool description", () => {
    expect(skillTool(skills).description).toContain("- deploy: Ship it");
  });

  it("returns the skill body with its directory context when invoked", async () => {
    const output = await skillTool(skills).execute({ name: "deploy" });
    expect(output).toContain("Step one. Step two.");
    expect(output).toContain("/repo/.keywork/skills/deploy");
  });

  it("rejects unknown skills and names the available ones", async () => {
    await expect(skillTool(skills).execute({ name: "nope" })).rejects.toThrow(
      'unknown skill "nope"; available: deploy',
    );
  });
});

async function probeDirectoryLinkSupport(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "keywork-skills-probe-"));
  try {
    await mkdir(join(root, "target"));
    await symlink(join(root, "target"), join(root, "link"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
