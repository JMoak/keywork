import type { FetchLike, McpServerStatus } from "@keywork/engine";
import type { SecretVault } from "@keywork/shared";
import type { McpServerView } from "@keywork/tui";
import { describe, expect, it } from "vitest";
import { type McpRegistryLike, mcpCommand, mcpPanePort } from "./mcp.ts";

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

describe("keywork mcp", () => {
  const servers = {
    files: { transport: "stdio" as const, command: "files-mcp" },
    github: { transport: "http" as const, url: "https://mcp.example.com/mcp" },
  };

  function memoryVault(): SecretVault & { names(): string[] } {
    const items = new Map<string, string>();
    return {
      backend: "memory",
      store: async (name, value) => void items.set(name, value),
      lookup: async (name) => items.get(name),
      forget: async (name) => void items.delete(name),
      names: () => [...items.keys()],
    };
  }

  function capture() {
    const out: string[] = [];
    const errors: string[] = [];
    return {
      out,
      errors,
      print: (line: string) => out.push(line),
      printError: (line: string) => errors.push(line),
    };
  }

  const offline: FetchLike = async () => new Response("", { status: 404 });

  it("lists servers with their transport and sign-in state", async () => {
    const io = capture();
    const vault = memoryVault();
    const code = await mcpCommand([], { servers, vault, fetchFn: offline, ...io });
    expect(code).toBe(0);
    expect(io.out).toEqual(["files · stdio", "github · http · not signed in"]);
  });

  it("refuses login for unknown or stdio servers with a usage exit", async () => {
    const io = capture();
    const base = { servers, vault: memoryVault(), fetchFn: offline, ...io };
    expect(await mcpCommand(["login"], base)).toBe(2);
    expect(await mcpCommand(["login", "nope"], base)).toBe(2);
    expect(await mcpCommand(["login", "files"], base)).toBe(2);
    expect(await mcpCommand(["frobnicate"], base)).toBe(2);
    expect(io.errors).toEqual([
      "keywork mcp login needs a server name",
      'keywork mcp login: no server named "nope" (known: files, github)',
      "keywork mcp login: files runs over stdio and has nothing to sign in to",
      'keywork mcp: unknown verb "frobnicate" (list · login <server> · logout <server>)',
    ]);
  });

  it("reports a server that cannot be signed in to without opening anything", async () => {
    const io = capture();
    const visited: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      visited.push(url);
      return new Response("", { status: 404 });
    };
    const code = await mcpCommand(["login", "github"], {
      servers,
      vault: memoryVault(),
      fetchFn,
      ...io,
    });
    expect(code).toBe(1);
    expect(io.errors[0]).toMatch(/^keywork mcp login github: .*no protected resource metadata/);
    expect(visited).toEqual([
      "https://mcp.example.com/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("logs out by forgetting the stored token", async () => {
    const io = capture();
    const vault = memoryVault();
    expect(
      await mcpCommand(["logout", "github"], { servers, vault, fetchFn: offline, ...io }),
    ).toBe(0);
    expect(io.out).toEqual(["github had no sign-in to forget"]);
  });
});
