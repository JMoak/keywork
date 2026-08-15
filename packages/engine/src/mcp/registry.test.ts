import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@keywork/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Tool } from "../tools.ts";
import { McpAbortedError, type McpConnection, type McpTool } from "./client.ts";
import {
  isMcpBackedTool,
  McpRegistry,
  McpRegistryClosedError,
  type McpRegistryOptions,
  McpServerNotFoundError,
  type McpServerState,
  type McpToolCallReport,
  mcpSearchToolName,
} from "./registry.ts";

const fixturePath = fileURLToPath(new URL("./fixture-server.ts", import.meta.url));

const registries: McpRegistry[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.stop()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeRegistry(options: McpRegistryOptions): McpRegistry {
  const registry = new McpRegistry(options);
  registries.push(registry);
  return registry;
}

function fixtureServer(profile: string, extraArgs: string[] = []): McpServerConfig {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [fixturePath, profile, ...extraArgs],
  };
}

function fakeConnection(tools: McpTool[]): McpConnection & { drop(error: Error): void } {
  const closeHandlers: Array<(error?: Error) => void> = [];
  return {
    serverName: "fake",
    listTools: () => Promise.resolve(tools),
    callTool: (name, args) =>
      Promise.resolve({ text: `${name}:${JSON.stringify(args)}`, isError: false }),
    onClose: (handler) => closeHandlers.push(handler),
    close: () => Promise.resolve(),
    drop: (error) => {
      for (const handler of closeHandlers) handler(error);
    },
  };
}

function fakeTool(name: string): McpTool {
  return {
    name,
    description: `Fake ${name} tool for tests.`,
    inputSchema: { type: "object", properties: {} },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function stateOf(registry: McpRegistry, name: string): McpServerState | undefined {
  return registry.status().find((status) => status.name === name)?.state;
}

function toolNames(registry: McpRegistry): string[] {
  return registry.tools().map((tool) => tool.name);
}

function findTool(registry: McpRegistry, name: string): Tool {
  const tool = registry.tools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not in surface`);
  return tool;
}

function surfaceTokens(registry: McpRegistry): number {
  const surface = registry.tools().map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  return Math.ceil(JSON.stringify(surface).length / 4);
}

describe("lazy tool surface", () => {
  it("keeps three connected servers under 200 tokens until a schema is fetched", async () => {
    const registry = makeRegistry({
      servers: {
        alpha: fixtureServer("basic"),
        beta: fixtureServer("basic"),
        gamma: fixtureServer("basic"),
      },
    });
    registry.start();
    await waitFor(() => registry.status().every((status) => status.state === "connected"));

    expect(toolNames(registry)).toEqual([mcpSearchToolName]);
    expect(surfaceTokens(registry)).toBeLessThan(200);
    const roster = findTool(registry, mcpSearchToolName).description;
    expect(roster).toContain("alpha__echo");
    expect(roster).toContain("gamma__add");
    expect(roster).toContain("Echoes the given text back verbatim.");
    expect(roster).not.toContain("inputSchema");
  });

  it("fetches schemas by exact name and makes the tool directly callable", async () => {
    const registry = makeRegistry({ servers: { alpha: fixtureServer("basic") } });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "connected");

    const fetched = await findTool(registry, mcpSearchToolName).execute({
      tools: ["alpha__echo"],
    });
    expect(fetched).toContain('"alpha__echo"');
    expect(fetched).toContain("directly callable");

    const echoed = await findTool(registry, "alpha__echo").execute({ text: "roundtrip" });
    expect(echoed).toBe("roundtrip");
  });

  it("namespaces duplicate tool names across servers", async () => {
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic"), beta: fixtureServer("basic") },
    });
    registry.start();
    await waitFor(() => registry.status().every((status) => status.state === "connected"));

    await findTool(registry, mcpSearchToolName).execute({ query: "echo" });
    expect(toolNames(registry)).toContain("alpha__echo");
    expect(toolNames(registry)).toContain("beta__echo");

    expect(await findTool(registry, "alpha__echo").execute({ text: "from alpha" })).toBe(
      "from alpha",
    );
    expect(await findTool(registry, "beta__echo").execute({ text: "from beta" })).toBe("from beta");
  });

  it("rejects schema fetches for unknown tools with the available roster", async () => {
    const registry = makeRegistry({ servers: { alpha: fixtureServer("basic") } });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "connected");

    await expect(
      findTool(registry, mcpSearchToolName).execute({ tools: ["alpha__nonsense"] }),
    ).rejects.toThrow(/unknown MCP tools: alpha__nonsense.*alpha__echo/s);
  });

  it("keeps composed agent surfaces live as tools activate", async () => {
    const base: Tool = {
      name: "read",
      description: "Reads a file.",
      parameters: { type: "object" },
      execute: () => Promise.resolve("ok"),
    };
    const registry = makeRegistry({ servers: { alpha: fixtureServer("basic") } });
    const view = registry.surface([base]);
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "connected");

    expect(view.map((tool) => tool.name)).toEqual(["read", mcpSearchToolName]);
    await findTool(registry, mcpSearchToolName).execute({ tools: ["alpha__echo"] });
    expect(view.map((tool) => tool.name)).toEqual(["read", mcpSearchToolName, "alpha__echo"]);

    registry.dropSurface(view);
    await registry.disable("alpha");
    expect(view.map((tool) => tool.name)).toEqual(["read", mcpSearchToolName, "alpha__echo"]);
  });

  it("exposes nothing at all with zero configured servers", () => {
    const registry = makeRegistry({ servers: {} });
    registry.start();
    expect(registry.tools()).toEqual([]);
    expect(registry.status()).toEqual([]);
  });
});

describe("server lifecycle", () => {
  it("reports connecting then connected through the subscription", async () => {
    const seen: McpServerState[] = [];
    const registry = makeRegistry({ servers: { alpha: fixtureServer("basic") } });
    registry.subscribe((statuses) => {
      const state = statuses.find((status) => status.name === "alpha")?.state;
      if (state !== undefined && seen.at(-1) !== state) seen.push(state);
    });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "connected");

    expect(seen).toEqual(["connecting", "connected"]);
    expect(registry.status()).toEqual([
      { name: "alpha", state: "connected", enabled: true, toolCount: 2 },
    ]);
    expect(registry.listTools("alpha").map((tool) => tool.name)).toEqual(["echo", "add"]);
  });

  it("marks a server that never handshakes as down with the timeout error", async () => {
    const registry = makeRegistry({
      servers: { mute: fixtureServer("silent") },
      requestTimeoutMs: 200,
      restartDelaysMs: [],
    });
    registry.start();
    await waitFor(() => stateOf(registry, "mute") === "down");

    const status = registry.status().find((candidate) => candidate.name === "mute");
    expect(status?.lastError).toContain("timed out");
    expect(status?.lastError).toContain("retry limit reached");
  });

  it("recovers a crash-once server through backoff", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keywork-mcp-"));
    tempDirs.push(dir);
    const registry = makeRegistry({
      servers: { flaky: fixtureServer("crash-once", [join(dir, "marker")]) },
      restartDelaysMs: [10, 10],
    });
    registry.start();
    await waitFor(() => stateOf(registry, "flaky") === "connected");

    expect(registry.listTools("flaky")).toHaveLength(2);
  });

  it("restarts after a mid-call crash and keeps activated tools callable", async () => {
    const registry = makeRegistry({
      servers: { hazard: fixtureServer("hazard") },
      restartDelaysMs: [10, 10, 10],
    });
    registry.start();
    await waitFor(() => stateOf(registry, "hazard") === "connected");
    await findTool(registry, mcpSearchToolName).execute({ query: "hazard" });

    await expect(findTool(registry, "hazard__boom").execute({})).rejects.toThrow(/exited/);
    await waitFor(() => stateOf(registry, "hazard") === "connected");
    expect(toolNames(registry)).toContain("hazard__boom");
  });

  it("truncates oversized tool results", async () => {
    const registry = makeRegistry({
      servers: { hazard: fixtureServer("hazard") },
      maxResultChars: 1_000,
    });
    registry.start();
    await waitFor(() => stateOf(registry, "hazard") === "connected");
    await findTool(registry, mcpSearchToolName).execute({ tools: ["hazard__blast"] });

    const output = await findTool(registry, "hazard__blast").execute({});
    expect(output.length).toBeLessThan(1_100);
    expect(output).toContain("[truncated 199000 characters]");
  });

  it("caps the restart storm and recovers via manual restart", async () => {
    let attempts = 0;
    let healthy = false;
    const registry = makeRegistry({
      servers: { storm: fixtureServer("basic") },
      restartDelaysMs: [5, 5],
      connect: () => {
        attempts += 1;
        if (!healthy) return Promise.reject(new Error("refused"));
        return Promise.resolve(fakeConnection([fakeTool("probe")]));
      },
    });
    registry.start();
    await waitFor(() => registry.status()[0]?.lastError?.includes("retry limit reached") === true);
    expect(attempts).toBe(3);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(3);

    healthy = true;
    await registry.restart("storm");
    expect(stateOf(registry, "storm")).toBe("connected");
    expect(attempts).toBe(4);
  });

  it("hides disabled servers from the model surface until re-enabled", async () => {
    const registry = makeRegistry({ servers: { alpha: fixtureServer("basic") } });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "connected");
    await findTool(registry, mcpSearchToolName).execute({ tools: ["alpha__echo"] });
    expect(toolNames(registry)).toContain("alpha__echo");

    await registry.disable("alpha");
    expect(toolNames(registry)).toEqual([mcpSearchToolName]);
    expect(findTool(registry, mcpSearchToolName).description).toContain("(no connected servers)");
    expect(registry.status()[0]).toMatchObject({ state: "down", enabled: false, toolCount: 0 });

    await registry.enable("alpha");
    await waitFor(() => stateOf(registry, "alpha") === "connected");
    expect(toolNames(registry)).toContain("alpha__echo");
  });

  it("marks http servers down until D9 lands", async () => {
    const registry = makeRegistry({
      servers: { remote: { transport: "http", url: "https://example.com/mcp" } },
      restartDelaysMs: [],
    });
    registry.start();
    await waitFor(() => stateOf(registry, "remote") === "down");
    expect(registry.status()[0]?.lastError).toContain("D9");
  });

  it("throws for unknown server names on control verbs", () => {
    const registry = makeRegistry({ servers: {} });
    expect(() => registry.listTools("ghost")).toThrow(McpServerNotFoundError);
  });
});

describe("structured lifecycle ownership", () => {
  function closableConnection(tools: McpTool[]): McpConnection & { closed: boolean } {
    const tracked = {
      ...fakeConnection(tools),
      closed: false,
      close: () => {
        tracked.closed = true;
        return Promise.resolve();
      },
    };
    return tracked;
  }

  it("coalesces a burst of contradictory transitions into one reconnect", async () => {
    let attempts = 0;
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      connect: () => {
        attempts += 1;
        return Promise.resolve(fakeConnection([fakeTool("probe")]));
      },
    });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "connected");
    expect(attempts).toBe(1);

    await Promise.all([
      registry.restart("alpha"),
      registry.disable("alpha"),
      registry.restart("alpha"),
      registry.enable("alpha"),
    ]);
    expect(stateOf(registry, "alpha")).toBe("connected");
    expect(attempts).toBe(2);
  });

  it("stop waits for an in-flight connect and closes the late connection", async () => {
    let release: ((connection: McpConnection) => void) | undefined;
    const opening = new Promise<McpConnection>((resolve) => {
      release = resolve;
    });
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      connect: () => opening,
    });
    registry.start();
    const late = closableConnection([fakeTool("probe")]);
    let stopped = false;
    const stopping = registry.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    release?.(late);
    await stopping;
    expect(late.closed).toBe(true);
  });

  it("stop interrupts retry backoff without waiting out the delay", async () => {
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      restartDelaysMs: [60_000],
      connect: () => Promise.reject(new Error("refused")),
    });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "down");
    const begun = Date.now();
    await registry.stop();
    expect(Date.now() - begun).toBeLessThan(1_000);
  });

  it("rejects control verbs once stopped", async () => {
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      connect: () => Promise.resolve(fakeConnection([fakeTool("probe")])),
    });
    registry.start();
    await registry.stop();
    await expect(registry.enable("alpha")).rejects.toThrow(McpRegistryClosedError);
    await expect(registry.disable("alpha")).rejects.toThrow(McpRegistryClosedError);
    await expect(registry.restart("alpha")).rejects.toThrow(McpRegistryClosedError);
  });

  it("closes the fresh connection when the tool listing fails", async () => {
    const doomed = closableConnection([]);
    doomed.listTools = () => Promise.reject(new Error("catalog unavailable"));
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      restartDelaysMs: [],
      connect: () => Promise.resolve(doomed),
    });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "down");
    expect(doomed.closed).toBe(true);
    expect(registry.status()[0]?.lastError).toContain("catalog unavailable");
  });

  it("a verb during backoff preempts the delay", async () => {
    let healthy = false;
    let attempts = 0;
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      restartDelaysMs: [60_000],
      connect: () => {
        attempts += 1;
        return healthy
          ? Promise.resolve(fakeConnection([fakeTool("probe")]))
          : Promise.reject(new Error("refused"));
      },
    });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "down");
    healthy = true;
    await registry.enable("alpha");
    expect(stateOf(registry, "alpha")).toBe("connected");
    expect(attempts).toBe(2);
  });

  function abortableConnect(): (spec: unknown, signal: AbortSignal) => Promise<McpConnection> {
    return (_spec, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new McpAbortedError()), { once: true });
      });
  }

  it("disable aborts a hung connect attempt instead of waiting it out", async () => {
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      connect: abortableConnect(),
    });
    registry.start();
    const begun = Date.now();
    await registry.disable("alpha");
    expect(Date.now() - begun).toBeLessThan(1_000);
    expect(registry.status()[0]).toMatchObject({ state: "down", enabled: false });
  });

  it("stop aborts a hung connect attempt and returns promptly", async () => {
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      connect: abortableConnect(),
    });
    registry.start();
    const begun = Date.now();
    await registry.stop();
    expect(Date.now() - begun).toBeLessThan(1_000);
  });

  it("restart aborts the previous attempt and connects fresh", async () => {
    let attempts = 0;
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      connect: (_spec, signal) => {
        attempts += 1;
        if (attempts === 1) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new McpAbortedError()), { once: true });
          });
        }
        return Promise.resolve(fakeConnection([fakeTool("probe")]));
      },
    });
    registry.start();
    await registry.restart("alpha");
    expect(stateOf(registry, "alpha")).toBe("connected");
    expect(attempts).toBe(2);
  });

  it("tears down a hung real handshake promptly on disable", async () => {
    const registry = makeRegistry({
      servers: { mute: fixtureServer("silent") },
      requestTimeoutMs: 8_000,
      restartDelaysMs: [],
    });
    registry.start();
    const begun = Date.now();
    await registry.disable("mute");
    expect(Date.now() - begun).toBeLessThan(4_000);
    expect(registry.status()[0]).toMatchObject({ state: "down", enabled: false });
  });

  it("keeps a single reconciler when a listener reenters during the first notification", async () => {
    let attempts = 0;
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      connect: () => {
        attempts += 1;
        return Promise.resolve(fakeConnection([fakeTool("probe")]));
      },
    });
    let disabling: Promise<void> | undefined;
    registry.subscribe((statuses) => {
      if (disabling === undefined && statuses[0]?.state === "connecting") {
        disabling = registry.disable("alpha");
      }
    });
    registry.start();
    await waitFor(() => disabling !== undefined);
    await disabling;
    expect(registry.status()[0]).toMatchObject({ state: "down", enabled: false });
    expect(attempts).toBe(1);
  });

  it("survives a connection whose close rejects", async () => {
    let generation = 0;
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      connect: () => {
        generation += 1;
        return Promise.resolve({
          ...fakeConnection([fakeTool(`probe-${generation}`)]),
          close: () => Promise.reject(new Error("close failed")),
        });
      },
    });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "connected");
    await registry.restart("alpha");
    expect(stateOf(registry, "alpha")).toBe("connected");
    expect(registry.listTools("alpha").map((tool) => tool.name)).toEqual(["probe-2"]);
    await registry.stop();
  });

  it("survives a throwing status listener", async () => {
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      connect: () => Promise.resolve(fakeConnection([fakeTool("probe")])),
    });
    registry.subscribe(() => {
      throw new Error("listener bug");
    });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "connected");
    await registry.stop();
    expect(stateOf(registry, "alpha")).toBe("down");
  });

  it("disable during backoff settles promptly and clears the failure", async () => {
    const registry = makeRegistry({
      servers: { alpha: fixtureServer("basic") },
      restartDelaysMs: [60_000],
      connect: () => Promise.reject(new Error("refused")),
    });
    registry.start();
    await waitFor(() => stateOf(registry, "alpha") === "down");
    await registry.disable("alpha");
    expect(registry.status()[0]).toMatchObject({ state: "down", enabled: false, toolCount: 0 });
    expect(registry.status()[0]?.lastError).toBeUndefined();
  });
});

describe("provenance marking", () => {
  it("reports untrusted results as external and trusted ones as exempt", async () => {
    const reports: McpToolCallReport[] = [];
    const registry = makeRegistry({
      servers: {
        wild: fixtureServer("basic"),
        tame: { ...fixtureServer("basic"), trusted: true },
      },
      onToolResult: (report) => reports.push(report),
    });
    registry.start();
    await waitFor(() => registry.status().every((status) => status.state === "connected"));
    await findTool(registry, mcpSearchToolName).execute({ query: "echo" });

    const wildEcho = findTool(registry, "wild__echo");
    const tameEcho = findTool(registry, "tame__echo");
    expect(isMcpBackedTool(wildEcho) && !wildEcho.mcp.trusted).toBe(true);
    expect(isMcpBackedTool(tameEcho) && tameEcho.mcp.trusted).toBe(true);

    await wildEcho.execute({ text: "a" });
    await tameEcho.execute({ text: "b" });
    expect(reports).toEqual([
      { server: "wild", tool: "echo", external: true },
      { server: "tame", tool: "echo", external: false },
    ]);
  });
});
