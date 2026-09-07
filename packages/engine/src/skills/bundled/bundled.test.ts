import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent.ts";
import { bundledSkillsRoot, discoverSkills, skillTool } from "../../extensions/skills.ts";
import type { ToolCallPart } from "../../messages.ts";
import { MockProvider, textTurn, toolCallTurn } from "../../mock-provider.ts";
import { bashTool } from "../../tools/bash.ts";
import { inspectProject, lintCommand, report, testCommand, typecheckCommand } from "./toolchain.ts";

const scratch = scratchDirs("keywork-bundled-skills-");

interface Fixture {
  readonly manifest: Record<string, unknown>;
  readonly files: Readonly<Record<string, string>>;
}

const vitestAndBiome: Fixture = {
  manifest: {
    name: "fixture-vitest-biome",
    devDependencies: { typescript: "5.9.3", vitest: "3.2.4", "@biomejs/biome": "2.2.0" },
  },
  files: { "bun.lock": "", "tsconfig.json": "{}", "biome.json": "{}" },
};

const bunTestAndEslint: Fixture = {
  manifest: {
    name: "fixture-bun-eslint",
    devDependencies: { typescript: "5.9.3", eslint: "9.36.0" },
  },
  files: { "bun.lock": "", "tsconfig.json": "{}", "eslint.config.js": "export default [];" },
};

const scriptedNpm: Fixture = {
  manifest: {
    name: "fixture-npm-scripts",
    scripts: { "check:types": "tsc --build", lint: "eslint src", test: "vitest run" },
    devDependencies: { typescript: "5.9.3", vitest: "3.2.4", eslint: "9.36.0" },
  },
  files: { "package-lock.json": "{}" },
};

const bare: Fixture = { manifest: { name: "fixture-bare" }, files: {} };

async function repoOf(fixture: Fixture): Promise<string> {
  const root = await scratch();
  await writeFile(join(root, "package.json"), JSON.stringify(fixture.manifest), "utf8");
  for (const [name, content] of Object.entries(fixture.files)) {
    await writeFile(join(root, name), content, "utf8");
  }
  return root;
}

async function resolvedCommands(fixture: Fixture) {
  const project = await inspectProject(await repoOf(fixture));
  return {
    typecheck: typecheckCommand(project),
    lint: lintCommand(project),
    test: testCommand(project),
  };
}

function call(callId: string, name: string, args: Record<string, unknown>): ToolCallPart {
  return { type: "tool-call", callId, name, arguments: args };
}

describe("toolchain resolution", () => {
  it("picks vitest, biome and tsc under bunx for a vitest+biome bun project", async () => {
    const commands = await resolvedCommands(vitestAndBiome);
    expect(commands.typecheck).toMatchObject({ tool: "tsc", command: "bunx tsc --noEmit" });
    expect(commands.lint).toMatchObject({ tool: "biome", command: "bunx biome check ." });
    expect(commands.test).toMatchObject({ tool: "vitest", command: "bunx vitest run" });
  });

  it("picks bun test and eslint for a bun project without vitest", async () => {
    const commands = await resolvedCommands(bunTestAndEslint);
    expect(commands.typecheck.command).toBe("bunx tsc --noEmit");
    expect(commands.lint).toMatchObject({ tool: "eslint", command: "bunx eslint ." });
    expect(commands.test).toMatchObject({ tool: "bun test", command: "bun test" });
  });

  it("prefers package scripts and the lockfile's package manager", async () => {
    const commands = await resolvedCommands(scriptedNpm);
    expect(commands.typecheck.command).toBe("npm run check:types");
    expect(commands.lint).toMatchObject({ tool: "eslint", command: "npm run lint" });
    expect(commands.test).toMatchObject({ tool: "vitest", command: "npm run test" });
  });

  it("says none rather than guessing when nothing is installed", async () => {
    const commands = await resolvedCommands(bare);
    expect(commands.typecheck.tool).toBe("none");
    expect(commands.lint.tool).toBe("none");
    expect(commands.test).toMatchObject({ tool: "none", command: "" });
    expect(report(commands.test)).toBe(
      "tool: none\ncommand: \nreason: no vitest and no bun lockfile",
    );
  });
});

describe("bundled skills in a mock conversation", () => {
  async function conversation(fixture: Fixture, skillName: string) {
    const root = await repoOf(fixture);
    const { skills } = await discoverSkills({ bundledRoot: bundledSkillsRoot });
    const skill = skills.find((candidate) => candidate.name === skillName);
    if (skill === undefined) throw new Error(`bundled skill ${skillName} missing`);
    const resolver = `bun "${join(skill.dir, "resolve.ts")}" "${root}"`;
    const provider = new MockProvider([
      toolCallTurn(call("c1", "skill", { name: skillName })),
      toolCallTurn(call("c2", "bash", { command: resolver })),
      textTurn("resolved"),
    ]);
    const agent = new Agent({ provider, tools: [skillTool(skills), bashTool(root)] });
    await agent.send(`run the ${skillName} for this project`);
    const outputs = agent
      .history()
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result")
      .map((part) => part.output);
    return { skillOutput: outputs[0] ?? "", resolverOutput: outputs[1] ?? "" };
  }

  it("resolves vitest for the vitest+biome repo through the skill's resolver", async () => {
    const { skillOutput, resolverOutput } = await conversation(vitestAndBiome, "test");
    expect(skillOutput).toContain('Skill "test"');
    expect(skillOutput).toContain("resolve.ts");
    expect(resolverOutput).toContain("tool: vitest\ncommand: bunx vitest run");
  }, 30_000);

  it("resolves bun test and eslint for the bun-test+eslint repo", async () => {
    const test = await conversation(bunTestAndEslint, "test");
    expect(test.resolverOutput).toContain("tool: bun test\ncommand: bun test");
    const lint = await conversation(bunTestAndEslint, "lint");
    expect(lint.resolverOutput).toContain("tool: eslint\ncommand: bunx eslint .");
  }, 30_000);

  it("resolves biome and tsc for the vitest+biome repo", async () => {
    const lint = await conversation(vitestAndBiome, "lint");
    expect(lint.resolverOutput).toContain("tool: biome\ncommand: bunx biome check .");
    const typecheck = await conversation(vitestAndBiome, "typecheck");
    expect(typecheck.resolverOutput).toContain("tool: tsc\ncommand: bunx tsc --noEmit");
  }, 30_000);
});
