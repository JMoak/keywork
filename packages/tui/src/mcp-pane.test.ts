import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { McpPane, type McpPanePort, mcpDropWatcher } from "./mcp-pane.ts";
import type { McpServerView } from "./mcp-pane-model.ts";
import { resolvePalette } from "./palette.ts";
import { AppProbe } from "./probe.ts";
import { dockedIds, dockOf, mustParse, paneIds, stubFilePane } from "./testing/workflow-probe.ts";

interface World {
  loads: number;
  restarted: string[];
  toggled: [string, boolean][];
  servers: McpServerView[];
  tools: Record<string, string[]>;
  failNextLoad: string | undefined;
  failNextTools: string | undefined;
}

function portOver(servers: McpServerView[]): { port: McpPanePort; world: World } {
  const world: World = {
    loads: 0,
    restarted: [],
    toggled: [],
    servers,
    tools: {},
    failNextLoad: undefined,
    failNextTools: undefined,
  };
  const port: McpPanePort = {
    load: async () => {
      world.loads += 1;
      if (world.failNextLoad !== undefined) {
        const message = world.failNextLoad;
        world.failNextLoad = undefined;
        throw new Error(message);
      }
      return world.servers;
    },
    restart: async (name) => {
      world.restarted.push(name);
      world.servers = world.servers.map((server) =>
        server.name === name
          ? { ...server, state: "connecting", progress: { stagesDone: 1, stageCount: 3 } }
          : server,
      );
    },
    setEnabled: async (name, on) => {
      world.toggled.push([name, on]);
      world.servers = world.servers.map((server) =>
        server.name === name ? { ...server, enabled: on } : server,
      );
    },
    listTools: async (name) => {
      if (world.failNextTools !== undefined) {
        const message = world.failNextTools;
        world.failNextTools = undefined;
        throw new Error(message);
      }
      return world.tools[name] ?? [];
    },
  };
  return { port, world };
}

async function paneOver(servers: McpServerView[]) {
  const { port, world } = portOver(servers);
  const pane = new McpPane("mcp-1", () => {}, port);
  await pane.settled();
  return { pane, world };
}

const fixture: McpServerView[] = [
  { name: "filesystem", state: "connected", toolCount: 12 },
  { name: "linear", state: "down", toolCount: 0, lastError: "spawn ENOENT" },
];

async function press(pane: McpPane, ...specs: string[]): Promise<void> {
  for (const spec of specs) {
    pane.handleKey(parseChord(spec));
    await pane.settled();
  }
}

function rendered(pane: McpPane): string {
  return JSON.stringify(describeTree(pane.view(context())));
}

describe("McpPane", () => {
  it("renders one healthy and one failing server with correct states", async () => {
    const { pane } = await paneOver(fixture);
    const body = rendered(pane);
    expect(body).toContain("█ filesystem · 12 tools");
    expect(body).toContain("░ linear · ▛");
    expect(body).toContain("  spawn ENOENT");
  });

  it("menu restart calls the port and the server walks connecting to connected", async () => {
    const { pane, world } = await paneOver(fixture);
    await press(pane, "j", "enter", "j", "enter");
    expect(world.restarted).toEqual(["linear"]);
    expect(rendered(pane)).toContain("▒ linear · ▌▀ connecting");
    expect(pane.title()).toBe(" mcp · █1 ▒1 ");
    world.servers = world.servers.map((server) =>
      server.name === "linear" ? { name: "linear", state: "connected", toolCount: 4 } : server,
    );
    await press(pane, "r");
    expect(rendered(pane)).toContain("█ linear · 4 tools");
    expect(pane.title()).toBe(" mcp · █2 ");
  });

  it("menu disable calls the port and the server renders off", async () => {
    const { pane, world } = await paneOver(fixture);
    await press(pane, "enter", "j", "j", "enter");
    expect(world.toggled).toEqual([["filesystem", false]]);
    expect(rendered(pane)).toContain("░ filesystem · off");
  });

  it("menu tools lists tool names inline through the port", async () => {
    const { pane, world } = await paneOver(fixture);
    world.tools.filesystem = ["read_file", "write_file"];
    await press(pane, "enter", "j", "j", "j", "enter");
    const body = rendered(pane);
    expect(body).toContain("    read_file");
    expect(body).toContain("    write_file");
  });

  it("pushes subscribed status snapshots into the model and unsubscribes on dispose", async () => {
    const { port } = portOver([]);
    let push: ((servers: McpServerView[]) => void) | undefined;
    let unsubscribed = false;
    port.subscribe = (listener) => {
      push = listener;
      return () => {
        unsubscribed = true;
      };
    };
    const pane = new McpPane("mcp-1", () => {}, port);
    await pane.settled();
    push?.([{ name: "late", state: "connected", toolCount: 3 }]);
    expect(pane.title()).toContain("█1");
    pane.dispose();
    expect(unsubscribed).toBe(true);
  });
});

describe("mcpDropWatcher", () => {
  it("notices only connected-to-down transitions, once each", () => {
    const notes: string[] = [];
    const watch = mcpDropWatcher((text) => notes.push(text));
    watch([{ name: "a", state: "connecting", toolCount: 0 }]);
    watch([{ name: "a", state: "down", toolCount: 0 }]);
    watch([{ name: "a", state: "connected", toolCount: 1 }]);
    watch([
      { name: "a", state: "down", toolCount: 0 },
      { name: "b", state: "connecting", toolCount: 0 },
    ]);
    watch([{ name: "a", state: "down", toolCount: 0 }]);
    expect(notes).toEqual(["mcp: a went down"]);
  });
});

function context() {
  return { theme: resolvePalette(), focused: true, width: 60, height: 20 };
}

function describeTree(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  const record = node as { props?: { content?: unknown; title?: unknown }; children?: unknown[] };
  return {
    ...(record.props?.title !== undefined && { title: record.props.title }),
    ...(record.props?.content !== undefined && { content: record.props.content }),
    ...(Array.isArray(record.children) && { children: record.children.map(describeTree) }),
  };
}

describe("McpPane command tray", () => {
  const trayFixture = (): McpServerView[] => [
    { name: "alpha", state: "connected", toolCount: 2 },
    { name: "beta", state: "down", toolCount: 0, lastError: "boom" },
  ];

  it("restarts the cursored server and reveals its menu", async () => {
    const { pane, world } = await paneOver(trayFixture());
    pane.handleKey(parseChord("/"));
    pane.handleKey(parseChord("enter"));
    await pane.settled();
    expect(world.restarted).toEqual(["alpha"]);
    expect(pane.model.rows().some((row) => row.id === "menu:alpha:restart")).toBe(true);
  });
});

describe("mcp status pane wiring", () => {
  function mcpFactory(servers: McpServerView[] = []) {
    const port: McpPanePort = {
      load: async () => servers,
      restart: async () => {},
      setEnabled: async () => {},
      listTools: async () => [],
    };
    return (id: string, notify: () => void) => new McpPane(id, notify, port);
  }

  it("auto-docks the pane on the right at startup without stealing focus", async () => {
    const probe = new AppProbe({
      createMcpPane: mcpFactory([{ name: "files", state: "connected", toolCount: 2 }]),
    });
    await probe.settled();
    expect(paneIds(probe)).toEqual(["session-1", "mcp-1"]);
    expect(dockedIds(probe)).toEqual(["mcp-1"]);
    expect(dockOf(probe, "mcp-1")).toBe("right");
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("a fresh start seeds sessions left, chat in main, mcp right, chat focused", async () => {
    const probe = new AppProbe({
      createMcpPane: mcpFactory(),
      createSessionTreePane: (id) => stubFilePane(id, "sessions"),
    });
    await probe.settled();
    expect(paneIds(probe)).toEqual(["tree-1", "session-1", "mcp-1"]);
    expect(dockOf(probe, "tree-1")).toBe("left");
    expect(dockOf(probe, "session-1")).toBeUndefined();
    expect(dockOf(probe, "mcp-1")).toBe("right");
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("revives a saved mcp pane without double-docking a second one", async () => {
    const first = new AppProbe({ createMcpPane: mcpFactory() });
    await first.settled();
    const state = mustParse(JSON.parse(JSON.stringify(first.workspaceState())));
    expect(state.panes.map((pane) => pane.kind)).toContain("mcp");

    const revived = new AppProbe({ createMcpPane: mcpFactory(), restoreWorkspace: state });
    await revived.settled();
    expect(paneIds(revived).filter((id) => id.startsWith("mcp-"))).toEqual(["mcp-1"]);
  });
});
