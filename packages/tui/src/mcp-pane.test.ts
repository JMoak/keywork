import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { McpPane, type McpPanePort, mcpDropWatcher } from "./mcp-pane.ts";
import type { McpServerView } from "./mcp-pane-model.ts";
import { AppProbe } from "./probe.ts";
import { dockedIds, dockOf, mustParse, paneIds, stubFilePane } from "./testing/workflow-probe.ts";
import { resolveTheme } from "./theme.ts";

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
  it("loads on construction and titles itself with density-ramp counts", async () => {
    const { pane, world } = await paneOver(fixture);
    expect(world.loads).toBe(1);
    expect(pane.title()).toBe(" mcp · █1 ░1 ");
  });

  it("describes itself as an mcp pane", async () => {
    const { pane } = await paneOver(fixture);
    expect(pane.describe()).toEqual({ kind: "mcp" });
  });

  it("renders one healthy and one failing server with correct states", async () => {
    const { pane } = await paneOver(fixture);
    const body = rendered(pane);
    expect(body).toContain("█ filesystem · 12 tools");
    expect(body).toContain("░ linear · ▛");
    expect(body).toContain("  spawn ENOENT");
  });

  it("constructed with zero servers it stays one calm line", async () => {
    const { pane } = await paneOver([]);
    expect(pane.title()).toBe(" mcp ");
    expect(rendered(pane)).toContain("no mcp servers configured");
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

  it("holds conflicting actions while a transition is in flight and releases after", async () => {
    const { port, world } = portOver(fixture);
    let release: () => void = () => {};
    port.restart = (name) => {
      world.restarted.push(name);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const pane = new McpPane("mcp-1", () => {}, port);
    await pane.settled();
    pane.handleKey(parseChord("enter"));
    pane.handleKey(parseChord("j"));
    pane.handleKey(parseChord("enter"));
    pane.handleKey(parseChord("enter"));
    pane.handleKey(parseChord("j"));
    pane.handleKey(parseChord("enter"));
    expect(world.restarted).toEqual(["filesystem"]);
    expect(world.toggled).toEqual([]);
    release();
    await pane.settled();
    pane.handleKey(parseChord("enter"));
    await pane.settled();
    expect(world.toggled).toEqual([["filesystem", false]]);
  });

  it("menu tools lists tool names inline through the port", async () => {
    const { pane, world } = await paneOver(fixture);
    world.tools.filesystem = ["read_file", "write_file"];
    await press(pane, "enter", "j", "j", "j", "enter");
    const body = rendered(pane);
    expect(body).toContain("    read_file");
    expect(body).toContain("    write_file");
  });

  it("a tools rejection renders inline and enter retries successfully", async () => {
    const { pane, world } = await paneOver(fixture);
    world.failNextTools = "transport closed";
    world.tools.filesystem = ["read_file"];
    await press(pane, "enter", "j", "j", "j", "enter");
    expect(rendered(pane)).toContain("▛ tools failed · transport closed");
    await press(pane, "j", "enter");
    expect(rendered(pane)).toContain("    read_file");
  });

  it("captures a load failure truthfully and recovers on the next refresh", async () => {
    const { pane, world } = await paneOver(fixture);
    world.failNextLoad = "config unreadable";
    await press(pane, "r");
    expect(rendered(pane)).toContain("config unreadable");
    await press(pane, "r");
    const recovered = rendered(pane);
    expect(recovered).not.toContain("config unreadable");
    expect(recovered).toContain("█ filesystem · 12 tools");
  });

  it("declines keys the model does not own", async () => {
    const { pane } = await paneOver(fixture);
    expect(pane.handleKey(parseChord("z"))).toBe(false);
  });

  it("a disposed pane ignores late completions and starts no new work", async () => {
    const { port, world } = portOver(fixture);
    let release: () => void = () => {};
    port.restart = (name) => {
      world.restarted.push(name);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    let notified = 0;
    const pane = new McpPane(
      "mcp-1",
      () => {
        notified += 1;
      },
      port,
    );
    await pane.settled();
    pane.handleKey(parseChord("enter"));
    pane.handleKey(parseChord("j"));
    pane.handleKey(parseChord("enter"));
    expect(world.restarted).toEqual(["filesystem"]);
    const loadsBefore = world.loads;
    pane.dispose();
    const notifiedBefore = notified;
    release();
    await pane.settled();
    expect(notified).toBe(notifiedBefore);
    expect(world.loads).toBe(loadsBefore);
    pane.refresh();
    await pane.settled();
    expect(world.loads).toBe(loadsBefore);
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
  return { theme: resolveTheme(), focused: true, width: 60, height: 20 };
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

  it("opens on / with the cursored server's actions plus refresh", async () => {
    const { pane } = await paneOver(trayFixture());
    pane.handleKey(parseChord("/"));
    expect(pane.tray.open).toBe(true);
    expect(pane.tray.matches().map((command) => command.name)).toEqual([
      "restart",
      "disable",
      "tools",
      "refresh",
    ]);
  });

  it("restarts the cursored server and reveals its menu", async () => {
    const { pane, world } = await paneOver(trayFixture());
    pane.handleKey(parseChord("/"));
    pane.handleKey(parseChord("enter"));
    await pane.settled();
    expect(world.restarted).toEqual(["alpha"]);
    expect(pane.model.rows().some((row) => row.id === "menu:alpha:restart")).toBe(true);
  });

  it("labels the toggle by the server's current state", async () => {
    const { pane } = await paneOver([
      { name: "alpha", state: "down", toolCount: 0, enabled: false },
    ]);
    pane.handleKey(parseChord("/"));
    expect(pane.tray.matches().map((command) => command.name)).toContain("enable");
  });

  it("runs refresh through the pane's own key path", async () => {
    const { pane, world } = await paneOver(trayFixture());
    const loadsBefore = world.loads;
    pane.handleKey(parseChord("/"));
    for (const character of "ref") pane.handleKey(parseChord(character), character);
    pane.handleKey(parseChord("enter"));
    await pane.settled();
    expect(world.loads).toBe(loadsBefore + 1);
    expect(pane.tray.open).toBe(false);
  });

  it("offers only refresh when no server is configured", async () => {
    const { pane } = await paneOver([]);
    pane.handleKey(parseChord("/"));
    expect(pane.tray.matches().map((command) => command.name)).toEqual(["refresh"]);
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

  it("per-side defaults: mcp homes right while the browser homes left", async () => {
    const probe = new AppProbe({
      createMcpPane: mcpFactory(),
      createBrowserPane: (id) => stubFilePane(id, "workspace"),
    });
    await probe.settled();
    probe.command("browse");
    expect(dockOf(probe, "browser-1")).toBe("left");
    expect(dockOf(probe, "mcp-1")).toBe("right");
    expect(paneIds(probe)).toEqual(["browser-1", "session-1", "mcp-1"]);
  });

  it("/mcp summons and refocuses the pane instead of duplicating it", async () => {
    const probe = new AppProbe({ createMcpPane: mcpFactory() });
    await probe.settled();
    probe.type("/mcp").keys("enter");
    expect(probe.snapshot().focused).toBe("mcp-1");
    expect(paneIds(probe)).toEqual(["session-1", "mcp-1"]);
  });

  it("with zero servers configured the pane never exists and /mcp is absent", () => {
    const probe = new AppProbe();
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.command("mcp")).toBe(false);
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
