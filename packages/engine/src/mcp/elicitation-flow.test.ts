import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@keywork/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallPart } from "../messages.ts";
import type { Tool } from "../tools.ts";
import { connectStdioServer, type McpConnection, type StdioServerSpec } from "./client.ts";
import {
  decliningElicitation,
  type ElicitationHandler,
  type ElicitationRequest,
} from "./elicitation.ts";
import { askGateElicitation, elicitationToolName } from "./elicitation-gate.ts";
import { McpRegistry } from "./registry.ts";
import { mcpSearchToolName } from "./tool-search.ts";

const fixturePath = fileURLToPath(new URL("../testing/mcp-fixture-server.ts", import.meta.url));

const connections: McpConnection[] = [];
const registries: McpRegistry[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(registries.splice(0).map((registry) => registry.stop()));
});

function askingSpec(): StdioServerSpec {
  return { command: process.execPath, args: [fixturePath, "asking", "--era=modern"] };
}

function askingServer(): McpServerConfig {
  return { transport: "stdio", command: process.execPath, args: [...(askingSpec().args ?? [])] };
}

async function connect(elicit?: ElicitationHandler): Promise<McpConnection> {
  const connection = await connectStdioServer(askingSpec(), {
    requestTimeoutMs: 5_000,
    ...(elicit !== undefined && { elicit }),
  });
  connections.push(connection);
  return connection;
}

const accepting =
  (content?: Record<string, unknown>): ElicitationHandler =>
  async () => ({ action: "accept", ...(content !== undefined && { content }) });

function recordingGuard(answer: boolean, gate: "user" | "headless" = "user") {
  const calls: ToolCallPart[] = [];
  return {
    calls,
    guard: {
      gate,
      confirm: async (call: ToolCallPart) => {
        calls.push(call);
        return answer;
      },
    },
  };
}

describe("elicitation through McpSession.callTool", () => {
  it("answers a form and the retried call succeeds with the echoed requestState", async () => {
    const seen: ElicitationRequest[] = [];
    const connection = await connect(async (request) => {
      seen.push(request);
      return { action: "accept", content: { name: "octocat", color: "Green" } };
    });
    const result = await connection.callTool("greet", {});
    expect(result).toEqual({ text: "hello octocat in Green", isError: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ mode: "form", key: "who", message: "Who should I greet?" });
  });

  it("ends a decline with a readable tool error carrying the reason", async () => {
    const connection = await connect(async () => ({ action: "decline", reason: "not today" }));
    const result = await connection.callTool("confirm", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe("not today · confirm: the user decline");
  });

  it("overrides the connection handler with a per-call one", async () => {
    const connection = await connect(decliningElicitation);
    const result = await connection.callTool("confirm", {}, { elicit: accepting() });
    expect(result).toEqual({ text: "confirmed", isError: false });
  });

  it("stops a server that asks again after a decline, and caps endless asking", async () => {
    const connection = await connect(accepting());
    await expect(connection.callTool("nag", {})).rejects.toThrow(/kept asking for input after 4/);
    const declining = await connect(async () => ({ action: "decline" }));
    await expect(declining.callTool("nag", {})).rejects.toThrow(/asked again after its request/);
  });

  it("advertises the elicitation client capability only when a handler is wired", async () => {
    const wired = await connect(accepting());
    expect(JSON.parse((await wired.callTool("capabilities", {})).text)).toEqual({
      elicitation: { form: {}, url: {} },
    });
    const bare = await connect();
    expect(JSON.parse((await bare.callTool("capabilities", {})).text)).toEqual({});
  });
});

describe("askGateElicitation", () => {
  it("routes a form through guard.confirm as a synthetic tool call and accepts with defaults", async () => {
    const { guard, calls } = recordingGuard(true);
    const connection = await connect(askGateElicitation(guard));
    const result = await connection.callTool("greet", {});
    expect(result).toEqual({ text: "hello friend in Red", isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: "tool-call",
      name: elicitationToolName,
      arguments: {
        server: "fixture-asking",
        message: "Who should I greet?",
        fields: { Name: "friend", color: "Red" },
      },
    });
    expect(calls[0]?.callId).toMatch(/^mcp_elicitation-/);
  });

  it("declines when the user says no, with a readable tool error", async () => {
    const { guard } = recordingGuard(false);
    const connection = await connect(askGateElicitation(guard));
    const result = await connection.callTool("confirm", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "fixture-asking asked for input and you declined · confirm: the user decline",
    );
  });

  it("declines without asking when a required field has no default", async () => {
    const { guard, calls } = recordingGuard(true);
    const connection = await connect(askGateElicitation(guard));
    const result = await connection.callTool("register", {});
    expect(calls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("asked for handle is required and keywork has no way to collect");
  });

  it("surfaces a url elicitation as the printed link and asks before accepting", async () => {
    const said: string[] = [];
    const { guard, calls } = recordingGuard(true);
    const connection = await connect(askGateElicitation(guard, { say: (line) => said.push(line) }));
    const result = await connection.callTool("connect", {});
    expect(result).toEqual({ text: "connected", isError: false });
    expect(said).toEqual([
      "fixture-asking asks you to open https://fixture.example/connect · Finish connecting in your browser",
    ]);
    expect(calls[0]?.arguments).toEqual({
      server: "fixture-asking",
      message: "Finish connecting in your browser",
      url: "https://fixture.example/connect",
    });
  });

  it("answers no for a headless guard, naming the missing answerer", async () => {
    const { guard } = recordingGuard(false, "headless");
    const connection = await connect(askGateElicitation(guard));
    const result = await connection.callTool("confirm", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "fixture-asking asked for input and this run has no one to answer",
    );
  });

  it("declines when the guard has no confirm at all", async () => {
    const connection = await connect(askGateElicitation({}));
    const result = await connection.callTool("confirm", {});
    expect(result.text).toContain("this run has no one to answer");
  });
});

describe("registry surfaces", () => {
  async function activated(registry: McpRegistry, elicit?: ElicitationHandler): Promise<Tool> {
    const deadline = Date.now() + 10_000;
    while (registry.status()[0]?.state !== "connected") {
      if (Date.now() > deadline) throw new Error("fixture never connected");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const surface = registry.surface([], elicit === undefined ? {} : { elicit });
    const search = surface().find((tool) => tool.name === mcpSearchToolName);
    if (search === undefined) throw new Error("no search tool");
    await search.execute({ tools: ["asking__confirm"] });
    const tool = surface().find((tool) => tool.name === "asking__confirm");
    if (tool === undefined) throw new Error("confirm tool not activated");
    return tool;
  }

  it("declines by default and asks through the surface's handler when one is given", async () => {
    const registry = new McpRegistry({ servers: { asking: askingServer() } });
    registries.push(registry);
    registry.start();
    const plain = await activated(registry);
    await expect(plain.execute({})).rejects.toThrow(
      "fixture-asking asked for input and no one was there to answer · confirm: the user decline",
    );
    const asking = await activated(registry, accepting());
    await expect(asking.execute({})).resolves.toBe("confirmed");
  });
});
