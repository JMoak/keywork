import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent.ts";
import type { ToolCallPart } from "../messages.ts";
import { MockProvider, textTurn } from "../mock-provider.ts";
import { recordingProvider } from "../testing/index.ts";
import type { Tool } from "../tools.ts";
import {
  type BotDefinition,
  defaultSigil,
  loadBots,
  narrowedPermissions,
  restrictTools,
} from "./bots.ts";

const scratch = scratchDirs("keywork-bots-");

async function projectWithBots(files: Record<string, string>): Promise<string> {
  const root = await scratch();
  await seedBots(root, files);
  return root;
}

async function seedBots(root: string, files: Record<string, string>): Promise<void> {
  for (const [slug, content] of Object.entries(files)) {
    const dir = join(root, ".keywork", "bots", slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bot.md"), content, "utf8");
  }
}

function stubTool(name: string, mutates = false): Tool {
  return {
    name,
    description: name,
    parameters: {},
    mutates,
    execute: () => Promise.resolve(`${name} ran`),
  };
}

function call(name: string): ToolCallPart {
  return { type: "tool-call", callId: "call-1", name, arguments: {} };
}

function bot(overrides: Partial<BotDefinition>): BotDefinition {
  return {
    name: "fixture",
    overrides: {},
    sigil: "F",
    learning: "notes",
    prompt: "",
    file: "fixture/bot.md",
    dir: "fixture",
    source: "project",
    ...overrides,
  };
}

describe("loadBots", () => {
  it("parses the full frontmatter and the prompt body from bots/<slug>/bot.md", async () => {
    const root = await projectWithBots({
      reviewer:
        "---\ndescription: Careful reviewer\nmodel: acme/large\ntools: [read, bash]\ndeny: [write]\nask: [bash]\nsigil: ⚖\nlearning: off\n---\nYou only review code.\n",
    });
    const { bots, failures } = await loadBots({ projectRoot: root });
    expect(failures).toEqual([]);
    expect(bots[0]).toMatchObject({
      name: "reviewer",
      description: "Careful reviewer",
      model: "acme/large",
      tools: ["read", "bash"],
      overrides: { deny: ["write"], ask: ["bash"] },
      sigil: "⚖",
      learning: "off",
      prompt: "You only review code.",
      dir: join(root, ".keywork", "bots", "reviewer"),
      source: "project",
    });
  });

  it("defaults learning to notes and the sigil to the slug's first letter", async () => {
    const root = await projectWithBots({ scout: "Scout ahead.\n" });
    const { bots } = await loadBots({ projectRoot: root });
    expect(bots[0]).toMatchObject({ name: "scout", sigil: "S", learning: "notes" });
    expect(defaultSigil("test-hawk")).toBe("T");
  });

  it("accepts a single string where a list is expected", async () => {
    const root = await projectWithBots({ scout: "---\ntools: read\n---\nScout.\n" });
    const { bots } = await loadBots({ projectRoot: root });
    expect(bots[0]?.tools).toEqual(["read"]);
  });

  it("quarantines unknown keys, a bad learning level, a wide sigil, and a hostile slug, keeping the rest", async () => {
    const root = await projectWithBots({
      stray: "---\ntemperature: 2\n---\nbody",
      eager: "---\nlearning: everything\n---\nbody",
      loud: "---\nsigil: AB\n---\nbody",
      Shouty: "fine body",
      fine: "prompt only",
    });
    const { bots, failures } = await loadBots({ projectRoot: root });
    expect(bots.map((found) => found.name)).toEqual(["fine"]);
    const reasons = failures.map((failure) => failure.reason);
    expect(reasons).toHaveLength(4);
    expect(reasons).toContain(
      'invalid bot slug "Shouty": use lowercase letters, digits, and inner hyphens',
    );
    expect(reasons).toContain("sigil: sigil must be exactly one glyph");
    expect(reasons.some((reason) => reason.startsWith("learning: "))).toBe(true);
    expect(reasons.some((reason) => reason.includes("temperature"))).toBe(true);
  });

  it("ignores loose markdown and directories without a bot.md", async () => {
    const root = await scratch();
    const botsDir = join(root, ".keywork", "bots");
    await mkdir(join(botsDir, "empty"), { recursive: true });
    await writeFile(join(botsDir, "loose.md"), "not a bot", "utf8");
    const { bots, failures } = await loadBots({ projectRoot: root });
    expect(bots).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("layers project over user, and a missing project root reads only the user's bots", async () => {
    const project = await projectWithBots({ scout: "project scout" });
    const user = await scratch();
    await seedBots(user, { scout: "user scout", mine: "global bot" });

    const layered = await loadBots({ projectRoot: project, userRoot: user });
    expect(layered.bots.map((found) => [found.name, found.prompt, found.source])).toEqual([
      ["scout", "project scout", "project"],
      ["mine", "global bot", "user"],
    ]);
    const userOnly = await loadBots({ userRoot: user });
    expect(userOnly.bots.map((found) => found.name)).toEqual(["mine", "scout"]);
  });
});

describe("restrictTools", () => {
  it("filters to the allowlist and never invents tools", () => {
    const tools = [stubTool("read"), stubTool("write"), stubTool("bash")];
    const restricted = restrictTools(tools, bot({ tools: ["read", "imaginary"] }));
    expect(restricted.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("leaves the tool list intact when no allowlist is declared", () => {
    const tools = [stubTool("read"), stubTool("write")];
    expect(restrictTools(tools, bot({}))).toEqual(tools);
  });
});

describe("narrowedPermissions", () => {
  it("can narrow: deny overrides an allowing base", () => {
    const resolver = narrowedPermissions(bot({ overrides: { deny: ["bash"] } }), () => "allow");
    expect(resolver(call("bash"))).toBe("deny");
  });

  it("never widens: an allow override cannot relax a stricter base", () => {
    const resolver = narrowedPermissions(bot({ overrides: { allow: ["bash"] } }), () => "ask");
    expect(resolver(call("bash"))).toBe("ask");
  });

  it("never widens past defaults: allow without a base verdict resolves to no verdict", () => {
    const resolver = narrowedPermissions(bot({ overrides: { allow: ["write"] } }));
    expect(resolver(call("write"))).toBeUndefined();
  });

  it("applies ask and deny even without a base resolver", () => {
    const resolver = narrowedPermissions(bot({ overrides: { ask: ["read"], deny: ["write"] } }));
    expect(resolver(call("read"))).toBe("ask");
    expect(resolver(call("write"))).toBe("deny");
    expect(resolver(call("bash"))).toBeUndefined();
  });

  it("keeps a denying entry authoritative when a tool is listed twice", () => {
    const resolver = narrowedPermissions(bot({ overrides: { allow: ["bash"], deny: ["bash"] } }));
    expect(resolver(call("bash"))).toBe("deny");
  });
});

describe("a bot in a mock conversation", () => {
  it("a learning: off bot restricts the tool list and swaps the system prompt exactly as the agent fixture did", async () => {
    const root = await projectWithBots({
      scout:
        "---\ntools: [read]\ndeny: [write]\nlearning: off\n---\nYou are the scout. Only read.\n",
    });
    const { bots } = await loadBots({ projectRoot: root });
    const scout = bots[0];
    if (scout === undefined) throw new Error("fixture bot missing");

    const provider = recordingProvider([textTurn("scouted")]);
    const allTools = [stubTool("read"), stubTool("write", true), stubTool("bash", true)];
    const agent = new Agent({
      provider,
      systemPrompt: scout.prompt,
      tools: restrictTools(allTools, scout),
      permissions: narrowedPermissions(scout),
    });
    await agent.send("look around");

    const request = provider.requests[0];
    expect(request?.systemPrompt).toBe("You are the scout. Only read.");
    expect(request?.tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("denies a tool the bot forbids, fail closed", async () => {
    const root = await projectWithBots({ scout: "---\ndeny: [write]\n---\nScout.\n" });
    const { bots } = await loadBots({ projectRoot: root });
    const scout = bots[0];
    if (scout === undefined) throw new Error("fixture bot missing");

    const writeCall: ToolCallPart = {
      type: "tool-call",
      callId: "call-w",
      name: "write",
      arguments: {},
    };
    const provider = new MockProvider([
      [
        { type: "tool-call", call: writeCall },
        { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      textTurn("done"),
    ]);
    const agent = new Agent({
      provider,
      tools: [stubTool("write", true)],
      permissions: narrowedPermissions(scout, () => "allow"),
    });
    await agent.send("try to write");

    const toolResult = agent
      .history()
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool-result");
    expect(toolResult).toMatchObject({ output: "denied by permission policy", isError: true });
  });
});
