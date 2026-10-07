import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@keywork/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Tool } from "../tools.ts";
import {
  connectStdioServer,
  type McpConnection,
  McpInputRequiredError,
  McpProtocolError,
  type StdioServerSpec,
} from "./client.ts";
import { McpRegistry } from "./registry.ts";
import { mcpSearchToolName } from "./tool-search.ts";

const fixturePath = fileURLToPath(new URL("../testing/mcp-fixture-server.ts", import.meta.url));

type FixtureEra = "legacy" | "modern" | "dual";

const connections: McpConnection[] = [];
const registries: McpRegistry[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(registries.splice(0).map((registry) => registry.stop()));
});

function fixtureSpec(profile: string, era: FixtureEra, ...flags: string[]): StdioServerSpec {
  return { command: process.execPath, args: fixtureArgs(profile, era, flags) };
}

function fixtureServer(era: FixtureEra): McpServerConfig {
  return { transport: "stdio", command: process.execPath, args: fixtureArgs("basic", era, []) };
}

function fixtureArgs(profile: string, era: FixtureEra, flags: string[]): string[] {
  return [fixturePath, profile, `--era=${era}`, ...flags];
}

async function connect(spec: StdioServerSpec): Promise<McpConnection> {
  const connection = await connectStdioServer(spec, { requestTimeoutMs: 5_000 });
  connections.push(connection);
  return connection;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function findTool(registry: McpRegistry, name: string): Tool {
  const tool = registry.tools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not in surface`);
  return tool;
}

describe("dual-era stdio client", () => {
  it.each([
    ["legacy", "legacy"],
    ["modern", "modern"],
    ["dual", "modern"],
  ] as const)("talks to a %s fixture through the registry as %s", async (fixtureEra, spoken) => {
    const registry = new McpRegistry({ servers: { alpha: fixtureServer(fixtureEra) } });
    registries.push(registry);
    registry.start();
    await waitFor(() => registry.status()[0]?.state === "connected");

    await findTool(registry, mcpSearchToolName).execute({ tools: ["alpha__echo"] });
    expect(await findTool(registry, "alpha__echo").execute({ text: spoken })).toBe(spoken);
    expect(registry.listTools("alpha").map((tool) => tool.name)).toEqual(["echo", "add"]);
  });

  it("probes with server/discover and stays modern on a modern-only server", async () => {
    const connection = await connect(fixtureSpec("basic", "modern"));
    expect(connection.era).toBe("modern");
    expect(connection.serverName).toBe("fixture-basic");
    expect(await connection.callTool("add", { a: 2, b: 3 })).toEqual({
      text: "5",
      isError: false,
    });
  });

  it("falls back to initialize when the probe is refused", async () => {
    const connection = await connect(fixtureSpec("basic", "legacy"));
    expect(connection.era).toBe("legacy");
    expect(connection.serverName).toBe("fixture-basic");
  });

  it("falls back to initialize once a silent discover probe times out", async () => {
    const begun = Date.now();
    const connection = await connectStdioServer(fixtureSpec("basic", "legacy", "--mute-discover"), {
      requestTimeoutMs: 5_000,
      discoverTimeoutMs: 150,
    });
    connections.push(connection);
    expect(connection.era).toBe("legacy");
    expect(Date.now() - begun).toBeLessThan(3_000);
    expect(await connection.callTool("echo", { text: "late" })).toEqual({
      text: "late",
      isError: false,
    });
  });

  it("skips the probe when the server is remembered as legacy", async () => {
    const connection = await connectStdioServer(fixtureSpec("basic", "dual"), {
      requestTimeoutMs: 5_000,
      rememberedEra: "legacy",
    });
    connections.push(connection);
    expect(connection.era).toBe("legacy");
  });

  it("hears tools/list_changed through subscriptions/listen", async () => {
    const connection = await connect(fixtureSpec("growing", "modern"));
    let changes = 0;
    connection.onToolsChanged(() => {
      changes += 1;
    });
    await connection.callTool("grow", {});
    await waitFor(() => changes === 1);
    expect((await connection.listTools()).map((tool) => tool.name)).toContain("sprout");
  });

  it("announces stale tools on the next call once the list ttl runs out", async () => {
    const connection = await connect(fixtureSpec("basic", "modern", "--ttl=40"));
    let staleSignals = 0;
    connection.onToolsChanged(() => {
      staleSignals += 1;
    });
    await connection.listTools();
    await connection.callTool("echo", { text: "fresh" });
    expect(staleSignals).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await connection.callTool("echo", { text: "stale" });
    await connection.callTool("echo", { text: "still stale" });
    expect(staleSignals).toBe(1);

    await connection.listTools();
    await connection.callTool("echo", { text: "fresh again" });
    expect(staleSignals).toBe(1);
  });

  it("never treats a legacy list as stale", async () => {
    const connection = await connect(fixtureSpec("basic", "legacy", "--ttl=0"));
    let staleSignals = 0;
    connection.onToolsChanged(() => {
      staleSignals += 1;
    });
    await connection.listTools();
    await connection.callTool("echo", { text: "x" });
    expect(staleSignals).toBe(0);
  });

  it("fails a call that comes back input_required with a clear message", async () => {
    const connection = await connect(fixtureSpec("asking", "modern"));
    const call = connection.callTool("confirm", {});
    await expect(call).rejects.toBeInstanceOf(McpInputRequiredError);
    await expect(call).rejects.toThrow(/fixture-asking asked for input.*elicitation\/create/);
  });

  it("names both sides' versions when a modern server refuses ours", async () => {
    const connection = connectStdioServer(
      { command: process.execPath, args: ["-e", refusingServerSource] },
      { requestTimeoutMs: 5_000 },
    );
    await expect(connection).rejects.toBeInstanceOf(McpProtocolError);
    await expect(connection).rejects.toThrow(/server speaks MCP 2099-01-01; keywork speaks/);
  });
});

const refusingServerSource = `
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n").filter(Boolean)) {
    const { id } = JSON.parse(line);
    const error = { code: -32022, message: "Unsupported protocol version", data: { supported: ["2099-01-01"] } };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;
