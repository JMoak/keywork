import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent.ts";
import { discoverSkills } from "../extensions/skills.ts";
import type { ToolCallPart } from "../messages.ts";
import { MockProvider, textTurn, toolCallTurn } from "../mock-provider.ts";
import { findTool, type Tool } from "../tools.ts";
import { SkillLibrary } from "./library.ts";
import { readSkillTelemetry, SkillTelemetry } from "./telemetry.ts";
import { clippedToBudget, skillLibraryTools } from "./tools.ts";

const scratch = scratchDirs("keywork-skill-tools-");

const staleAgentSkill = [
  "---",
  'description: "Build the project"',
  "authored_by: keywork",
  "---",
  "Build with `make build-old`, then run the checks.",
  "",
].join("\n");

const humanSkill = [
  "---",
  "description: Hand-written build notes",
  "---",
  "Build with `make build-old`.",
  "",
].join("\n");

async function seedSkill(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, ".keywork", "skills", name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  await writeFile(file, content, "utf8");
  return file;
}

const runTool: Tool = {
  name: "run",
  description: "Runs a build command.",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  execute: async (args) => {
    const command = (args as { command: string }).command;
    if (command.includes("build-old"))
      throw new Error(`make: *** No rule to make target 'build-old'`);
    return `${command}: ok`;
  },
};

function call(callId: string, name: string, args: Record<string, unknown>): ToolCallPart {
  return { type: "tool-call", callId, name, arguments: args };
}

async function fixture(root: string) {
  const { skills } = await discoverSkills({ projectRoot: root });
  const telemetryFile = join(root, "state", "skills.json");
  const telemetry = await SkillTelemetry.open({ file: telemetryFile });
  const library = new SkillLibrary({
    skills,
    telemetry,
    genesis: { root, source: "project", convention: ".keywork/skills" },
  });
  const used: string[] = [];
  const tools = [
    ...skillLibraryTools(library, { onUse: (skill) => used.push(skill.name) }),
    runTool,
  ];
  return { library, telemetryFile, tools, used };
}

describe("self-healing skills end to end", () => {
  it("patches a stale agent skill mid-run, persists the fix, and cannot touch a human skill", async () => {
    const root = await scratch();
    const staleFile = await seedSkill(root, "build", staleAgentSkill);
    const humanFile = await seedSkill(root, "manual-build", humanSkill);
    const { tools, telemetryFile, used } = await fixture(root);
    const provider = new MockProvider([
      toolCallTurn(call("c1", "skill", { name: "build" })),
      toolCallTurn(call("c2", "run", { command: "make build-old" })),
      toolCallTurn(
        call("c3", "skill_patch", {
          name: "build",
          oldText: "make build-old",
          newText: "make build-new",
        }),
      ),
      toolCallTurn(call("c4", "run", { command: "make build-new" })),
      toolCallTurn(call("c5", "skill", { name: "build" })),
      toolCallTurn(
        call("c6", "skill_patch", {
          name: "manual-build",
          oldText: "make build-old",
          newText: "make build-new",
        }),
      ),
      textTurn("Built; the build skill is repaired and manual-build needs your hand."),
    ]);
    const agent = new Agent({ provider, tools });

    await agent.send("Build the project");

    const results = agent
      .history()
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result");
    expect(results.map((part) => part.isError)).toEqual([false, true, false, false, false, true]);
    expect(results[2]?.output).toContain('Patched skill "build"');
    expect(results[4]?.output).toContain("make build-new");
    expect(results[5]?.output).toContain("protected");

    const patched = await readFile(staleFile, "utf8");
    expect(patched).toContain("make build-new");
    expect(patched).toContain('authored_by: "keywork"');
    const rediscovered = await discoverSkills({ projectRoot: root });
    expect(rediscovered.skills.find((skill) => skill.name === "build")?.body).toBe(
      "Build with `make build-new`, then run the checks.",
    );
    expect(await readFile(humanFile, "utf8")).toBe(humanSkill);

    const telemetry = await readSkillTelemetry(telemetryFile);
    expect(telemetry.build?.counts).toMatchObject({ use: 2, patch: 1 });
    expect(telemetry["manual-build"]).toBeUndefined();
    expect(used).toEqual(["build", "build"]);
  });

  it("creates a skill from a discovered workflow that later sessions can load", async () => {
    const root = await scratch();
    const { tools, library } = await fixture(root);
    const provider = new MockProvider([
      toolCallTurn(
        call("c1", "skill_create", {
          name: "release-tag",
          description: "Cut a release tag",
          body: "1. Run `bun run check`.\n2. Tag with `git tag vX`.",
        }),
      ),
      toolCallTurn(call("c2", "skills_list", {})),
      textTurn("Captured."),
    ]);
    const agent = new Agent({ provider, tools });

    await agent.send("Remember how we cut releases");

    const listing = agent
      .history()
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result")[1]?.output;
    expect(listing).toContain("- release-tag (project, authored by keywork, repairable)");
    expect(findTool(tools, "skill").description).toContain("- release-tag: Cut a release tag");
    expect(library.skills().map((skill) => skill.name)).toEqual(["release-tag"]);
    const { skills } = await discoverSkills({ projectRoot: root });
    expect(skills[0]?.body).toBe("1. Run `bun run check`.\n2. Tag with `git tag vX`.");
  });
});

describe("progressive disclosure tools", () => {
  it("lists metadata, views a skill with references, and reads a reference file", async () => {
    const root = await scratch();
    await seedSkill(root, "build", staleAgentSkill);
    await seedSkill(root, "manual-build", humanSkill);
    await writeFile(join(root, ".keywork", "skills", "build", "FLAGS.md"), "--fast", "utf8");
    const { tools } = await fixture(root);

    const listed = await findTool(tools, "skills_list").execute({});
    expect(listed).toBe(
      [
        "- build (project, authored by keywork, repairable): Build the project",
        "- manual-build (project, protected): Hand-written build notes",
      ].join("\n"),
    );
    const viewed = await findTool(tools, "skill_view").execute({ name: "build" });
    expect(viewed).toContain('Skill "build" (authored by keywork, repairable)');
    expect(viewed).toContain("Build with `make build-old`");
    expect(viewed).toContain("- FLAGS.md");
    await expect(
      findTool(tools, "skill_view").execute({ name: "build", file: "FLAGS.md" }),
    ).resolves.toBe("--fast");
  });

  it("offers skill_create only when a genesis root exists and marks mutating tools", async () => {
    const bare = skillLibraryTools(new SkillLibrary({ skills: [] }));
    expect(bare.map((tool) => tool.name)).toEqual([
      "skill",
      "skills_list",
      "skill_view",
      "skill_patch",
      "skill_rewrite",
    ]);
    expect(findTool(bare, "skill").description).toContain("No skills are available yet");
    expect(bare.filter((tool) => tool.mutates === true).map((tool) => tool.name)).toEqual([
      "skill_patch",
      "skill_rewrite",
    ]);
  });

  it("clips output to the budget with a pointer to narrower views", async () => {
    const root = await scratch();
    await seedSkill(root, "build", staleAgentSkill.replace("run the checks", "x".repeat(500)));
    const { skills } = await discoverSkills({ projectRoot: root });
    const tools = skillLibraryTools(new SkillLibrary({ skills }), { outputBudget: 120 });

    const output = await findTool(tools, "skill").execute({ name: "build" });
    expect(output.length).toBeLessThan(250);
    expect(output).toMatch(/clipped \d+ more characters/);
    expect(clippedToBudget("short", 10)).toBe("short");
  });
});
