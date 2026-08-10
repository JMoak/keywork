import type { McpServerStatus } from "@keywork/engine";
import type { McpServerView } from "@keywork/tui";
import { describe, expect, it } from "vitest";
import { type McpRegistryLike, mcpPanePort } from "./mcp.ts";

interface StubWorld {
  restarted: string[];
  enabled: string[];
  disabled: string[];
  statuses: McpServerStatus[];
  listeners: ((statuses: McpServerStatus[]) => void)[];
}

function stubRegistry(statuses: McpServerStatus[]): {
  registry: McpRegistryLike;
  world: StubWorld;
} {
  const world: StubWorld = { restarted: [], enabled: [], disabled: [], statuses, listeners: [] };
  const registry: McpRegistryLike = {
    status: () => world.statuses,
    subscribe: (listener) => {
      world.listeners.push(listener);
      return () => {};
    },
    enable: async (name) => {
      world.enabled.push(name);
    },
    disable: async (name) => {
      world.disabled.push(name);
    },
    restart: async (name) => {
      world.restarted.push(name);
    },
    listTools: (name) => [
      { name: `${name}-echo`, description: "Echoes.", inputSchema: { type: "object" } },
    ],
  };
  return { registry, world };
}

const connected: McpServerStatus = {
  name: "files",
  state: "connected",
  enabled: true,
  toolCount: 2,
};

describe("mcpPanePort", () => {
  it("maps registry statuses onto pane server views, keeping errors when present", async () => {
    const { registry } = stubRegistry([
      connected,
      { name: "linear", state: "down", enabled: true, toolCount: 0, lastError: "spawn ENOENT" },
    ]);
    await expect(mcpPanePort(registry).load()).resolves.toEqual([
      { name: "files", state: "connected", enabled: true, toolCount: 2 },
      { name: "linear", state: "down", enabled: true, toolCount: 0, lastError: "spawn ENOENT" },
    ]);
  });

  it("routes restart and the enable/disable toggle to the registry verbs", async () => {
    const { registry, world } = stubRegistry([connected]);
    const port = mcpPanePort(registry);
    await port.restart("files");
    await port.setEnabled("files", false);
    await port.setEnabled("files", true);
    expect(world.restarted).toEqual(["files"]);
    expect(world.disabled).toEqual(["files"]);
    expect(world.enabled).toEqual(["files"]);
  });

  it("lists tool names for a server", async () => {
    const { registry } = stubRegistry([connected]);
    await expect(mcpPanePort(registry).listTools("files")).resolves.toEqual(["files-echo"]);
  });

  it("relays status subscriptions as pane views", () => {
    const { registry, world } = stubRegistry([connected]);
    const seen: McpServerView[][] = [];
    mcpPanePort(registry).subscribe?.((servers) => seen.push(servers));
    world.listeners[0]?.([{ name: "files", state: "down", enabled: true, toolCount: 0 }]);
    expect(seen).toEqual([[{ name: "files", state: "down", enabled: true, toolCount: 0 }]]);
  });
});
