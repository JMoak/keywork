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
  type AgentDefinition,
  loadAgents,
  narrowedPermissions,
  restrictTools,
} from "./markdown-agents.ts";

const scratch = scratchDirs("keywork-agents-");

async function projectWithAgents(files: Record<string, string>): Promise<string> {
  const root = await scratch();
  const dir = join(root, ".keywork", "agents");
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return root;
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

function definition(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: "fixture",
    overrides: {},
    prompt: "",
    file: "fixture.md",
    source: "project",
    ...overrides,
  };
}

describe("loadAgents", () => {
  it("parses model, tools allowlist, permission overrides, and the prompt body", async () => {
    const root = await projectWithAgents({
      "reviewer.md":
        "---\ndescription: Careful reviewer\nmodel: some-model\ntools: [read, bash]\ndeny: [write]\nask: [bash]\n---\nYou only review code.\n",
    });
    const { agents, failures } = await loadAgents({ projectRoot: root });
    expect(failures).toEqual([]);
    expect(agents[0]).toMatchObject({
      name: "reviewer",
      description: "Careful reviewer",
      model: "some-model",
      tools: ["read", "bash"],
      overrides: { deny: ["write"], ask: ["bash"] },
      prompt: "You only review code.",
    });
  });

  it("quarantines malformed agent files and keeps the rest", async () => {
    const root = await projectWithAgents({
      "broken.md": "---\ntools: [never closed\n---\nbody",
      "fine.md": "prompt only",
    });
    const { agents, failures } = await loadAgents({ projectRoot: root });
    expect(agents.map((agent) => agent.name)).toEqual(["fine"]);
    expect(failures).toHaveLength(1);
  });
});

describe("restrictTools", () => {
  it("filters to the allowlist and never invents tools", () => {
    const tools = [stubTool("read"), stubTool("write"), stubTool("bash")];
    const restricted = restrictTools(tools, definition({ tools: ["read", "imaginary"] }));
    expect(restricted.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("leaves the tool list intact when no allowlist is declared", () => {
    const tools = [stubTool("read"), stubTool("write")];
    expect(restrictTools(tools, definition({}))).toEqual(tools);
  });
});

describe("narrowedPermissions", () => {
  it("can narrow: deny overrides an allowing base", () => {
    const resolver = narrowedPermissions(
      definition({ overrides: { deny: ["bash"] } }),
      () => "allow",
    );
    expect(resolver(call("bash"))).toBe("deny");
  });

  it("never widens: an allow override cannot relax a stricter base", () => {
    const resolver = narrowedPermissions(
      definition({ overrides: { allow: ["bash"] } }),
      () => "ask",
    );
    expect(resolver(call("bash"))).toBe("ask");
  });

  it("never widens past defaults: allow without a base verdict resolves to no verdict", () => {
    const resolver = narrowedPermissions(definition({ overrides: { allow: ["write"] } }));
    expect(resolver(call("write"))).toBeUndefined();
  });

  it("applies ask and deny even without a base resolver", () => {
    const resolver = narrowedPermissions(
      definition({ overrides: { ask: ["read"], deny: ["write"] } }),
    );
    expect(resolver(call("read"))).toBe("ask");
    expect(resolver(call("write"))).toBe("deny");
    expect(resolver(call("bash"))).toBeUndefined();
  });

  it("keeps a denying entry authoritative when a tool is listed twice", () => {
    const resolver = narrowedPermissions(
      definition({ overrides: { allow: ["bash"], deny: ["bash"] } }),
    );
    expect(resolver(call("bash"))).toBe("deny");
  });
});

describe("a markdown agent in a mock conversation", () => {
  it("restricts the tool list and swaps the system prompt", async () => {
    const root = await projectWithAgents({
      "scout.md": "---\ntools: [read]\ndeny: [write]\n---\nYou are the scout. Only read.\n",
    });
    const { agents } = await loadAgents({ projectRoot: root });
    const scout = agents[0];
    if (scout === undefined) throw new Error("fixture agent missing");

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

  it("denies a tool the agent file forbids, fail closed", async () => {
    const root = await projectWithAgents({ "scout.md": "---\ndeny: [write]\n---\nScout.\n" });
    const { agents } = await loadAgents({ projectRoot: root });
    const scout = agents[0];
    if (scout === undefined) throw new Error("fixture agent missing");

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
