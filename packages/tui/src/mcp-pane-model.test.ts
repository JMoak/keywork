import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import {
  McpPaneModel,
  type McpServerState,
  type McpServerView,
  mcpToneToken,
  stateGlyph,
  tileMark,
} from "./mcp-pane-model.ts";
import { resolveTheme } from "./theme.ts";

interface ServerSpec {
  name: string;
  state?: McpServerState;
  toolCount?: number;
  enabled?: boolean;
  lastError?: string;
  progress?: { stagesDone: number; stageCount: number };
}

function serverOf(spec: ServerSpec): McpServerView {
  return {
    name: spec.name,
    state: spec.state ?? "connected",
    toolCount: spec.toolCount ?? 3,
    ...(spec.enabled !== undefined && { enabled: spec.enabled }),
    ...(spec.lastError !== undefined && { lastError: spec.lastError }),
    ...(spec.progress !== undefined && { progress: spec.progress }),
  };
}

interface Recorded {
  refreshes: number;
  restarted: string[];
  toggled: [string, boolean][];
  listed: string[];
}

function modelOver(servers: ServerSpec[]) {
  const recorded: Recorded = { refreshes: 0, restarted: [], toggled: [], listed: [] };
  const model = new McpPaneModel(() => {}, {
    refresh: () => {
      recorded.refreshes += 1;
    },
    restart: (name) => recorded.restarted.push(name),
    setEnabled: (name, on) => recorded.toggled.push([name, on]),
    listTools: (name) => recorded.listed.push(name),
  });
  model.setServers(servers.map(serverOf));
  return { model, recorded };
}

function press(model: McpPaneModel, ...specs: string[]): void {
  for (const spec of specs) model.handleKey(parseChord(spec), 5);
}

function texts(model: McpPaneModel): string[] {
  return model.rows().map((row) => row.text);
}

const pair: ServerSpec[] = [
  { name: "filesystem", toolCount: 12 },
  { name: "linear", state: "down", toolCount: 0, lastError: "spawn ENOENT: linear-mcp not found" },
];

describe("McpPaneModel empty state", () => {
  it("renders one calm dim line when constructed with no servers", () => {
    const { model } = modelOver([]);
    expect(texts(model)).toEqual(["no mcp servers configured"]);
    expect(model.rows()[0]?.tone).toBe("dim");
    expect(model.rows()[0]?.selectable).toBe(false);
  });

  it("navigation and activation on the empty state never throw or act", () => {
    const { model, recorded } = modelOver([]);
    press(model, "j", "k", "enter", "h", "pagedown", "pageup", "escape");
    expect(model.cursor).toBe(0);
    expect(recorded.restarted).toEqual([]);
    expect(recorded.listed).toEqual([]);
  });
});

describe("McpPaneModel status lines", () => {
  it("renders healthy and failing servers with density-ramp glyphs", () => {
    const { model } = modelOver(pair);
    expect(texts(model)).toEqual([
      "█ filesystem · 12 tools",
      "░ linear · ▛",
      "  spawn ENOENT: linear-mcp not found",
    ]);
  });

  it("keeps the failing server's error on a dim non-selectable line", () => {
    const { model } = modelOver(pair);
    const error = model.rows().find((row) => row.kind === "error");
    expect(error?.tone).toBe("dim");
    expect(error?.selectable).toBe(false);
  });

  it("speaks the full density ramp: connected █, connecting ▒, down ░", () => {
    expect(stateGlyph("connected")).toBe("█");
    expect(stateGlyph("connecting")).toBe("▒");
    expect(stateGlyph("down")).toBe("░");
  });

  it("shows a connecting server with the tile-fill mark from its progress", () => {
    const { model } = modelOver([
      { name: "docs", state: "connecting", progress: { stagesDone: 1, stageCount: 3 } },
    ]);
    expect(texts(model)).toEqual(["▒ docs · ▌▀ connecting"]);
  });

  it("advances the tile-fill mark deterministically across handshake stages", () => {
    const stages = [0, 1, 2, 3].map((done) => tileMark({ stagesDone: done, stageCount: 3 }));
    expect(stages).toEqual(["▌", "▌▀", "▌▀▗", "█"]);
    expect(tileMark()).toBe("▌");
    expect(tileMark({ stagesDone: 2, stageCount: 0 })).toBe("▌");
  });

  it("says no tools for a zero-tool server and singular for one", () => {
    const { model } = modelOver([
      { name: "bare", toolCount: 0 },
      { name: "single", toolCount: 1 },
    ]);
    expect(texts(model)).toEqual(["█ bare · no tools", "█ single · 1 tool"]);
  });

  it("renders a disabled server dim as off", () => {
    const { model } = modelOver([{ name: "paused", enabled: false }]);
    const row = model.rows()[0];
    expect(row?.text).toBe("░ paused · off");
    expect(row?.tone).toBe("dim");
    expect(row?.selectable).toBe(true);
  });

  it("bounds very long names and errors instead of flooding the line", () => {
    const { model } = modelOver([
      {
        name: "a-server-name-so-long-it-would-wrap-the-entire-dock-pane-twice-over",
        state: "down",
        toolCount: 0,
        lastError: "x".repeat(300),
      },
    ]);
    const [server, error] = texts(model);
    expect(server?.length).toBeLessThanOrEqual(40);
    expect(server?.endsWith("… · ▛")).toBe(true);
    expect(error?.length).toBeLessThanOrEqual(52);
    expect(error?.endsWith("…")).toBe(true);
  });

  it("counts servers by state for the title", () => {
    const { model } = modelOver([
      ...pair,
      { name: "docs", state: "connecting" },
      { name: "extra", state: "down", toolCount: 0 },
    ]);
    expect(model.serverCount()).toBe(4);
    expect(model.counts()).toEqual({ connected: 1, connecting: 1, down: 2 });
  });

  it("maps tones to distinct theme tokens", () => {
    const theme = resolveTheme();
    const tokens = (["dim", "normal", "alert"] as const).map((tone) => theme[mcpToneToken(tone)]);
    expect(new Set(tokens).size).toBe(3);
  });
});

describe("McpPaneModel server menu", () => {
  it("enter on a server opens its menu; enter again closes it", () => {
    const { model } = modelOver(pair);
    press(model, "enter");
    expect(texts(model)).toContain("  restart");
    expect(texts(model)).toContain("  disable");
    expect(texts(model)).toContain("  tools");
    press(model, "enter");
    expect(texts(model)).not.toContain("  restart");
  });

  it("restart from the menu calls the effect for that server", () => {
    const { model, recorded } = modelOver(pair);
    press(model, "j", "enter", "j", "enter");
    expect(recorded.restarted).toEqual(["linear"]);
  });

  it("restart while the server is already connecting still asks the port", () => {
    const { model, recorded } = modelOver([
      { name: "docs", state: "connecting", progress: { stagesDone: 0, stageCount: 3 } },
    ]);
    press(model, "enter", "j", "enter");
    expect(recorded.restarted).toEqual(["docs"]);
  });

  it("toggle sends disable for an enabled server and enable for a disabled one", () => {
    const { model, recorded } = modelOver([{ name: "on" }, { name: "off", enabled: false }]);
    press(model, "enter", "j", "j", "enter");
    expect(recorded.toggled).toEqual([["on", false]]);
    press(model, "h", "j", "enter");
    expect(model.cursorRow()?.id).toBe("server:off");
    press(model, "j", "j", "enter");
    expect(recorded.toggled).toEqual([
      ["on", false],
      ["off", true],
    ]);
    expect(texts(model)).toContain("  enable");
  });

  it("h collapses the menu from anywhere inside it and returns to the server", () => {
    const { model } = modelOver(pair);
    press(model, "enter", "j", "j", "h");
    expect(model.cursorRow()?.id).toBe("server:filesystem");
    expect(texts(model)).not.toContain("  restart");
  });

  it("escape outside any menu is calm", () => {
    const { model } = modelOver(pair);
    press(model, "escape");
    expect(model.cursorRow()?.id).toBe("server:filesystem");
  });

  it("r asks for a refresh", () => {
    const { model, recorded } = modelOver(pair);
    press(model, "r");
    expect(recorded.refreshes).toBe(1);
  });

  it("unhandled keys fall through", () => {
    const { model } = modelOver(pair);
    expect(model.handleKey(parseChord("z"), 5)).toBe(false);
  });
});

describe("McpPaneModel transition holds", () => {
  it("dims restart and toggle while a server transition is in flight", () => {
    const { model } = modelOver(pair);
    press(model, "enter");
    model.setBusy("filesystem", true);
    const actions = model
      .rows()
      .filter((row) => row.kind === "action")
      .map((row) => [row.id, row.tone]);
    expect(actions).toEqual([
      ["menu:filesystem:restart", "dim"],
      ["menu:filesystem:toggle", "dim"],
      ["menu:filesystem:tools", "normal"],
    ]);
  });

  it("ignores restart and toggle for a busy server and resumes after release", () => {
    const { model, recorded } = modelOver(pair);
    model.setBusy("filesystem", true);
    press(model, "enter", "j", "enter", "j", "enter");
    expect(recorded.restarted).toEqual([]);
    expect(recorded.toggled).toEqual([]);
    model.setBusy("filesystem", false);
    press(model, "enter");
    expect(recorded.toggled).toEqual([["filesystem", false]]);
  });

  it("still lists tools for a busy server", () => {
    const { model, recorded } = modelOver(pair);
    model.setBusy("filesystem", true);
    press(model, "enter", "j", "j", "j", "enter");
    expect(recorded.listed).toEqual(["filesystem"]);
  });

  it("clears the hold for vanished servers", () => {
    const { model } = modelOver(pair);
    model.setBusy("filesystem", true);
    model.setServers([serverOf({ name: "linear", state: "down" })]);
    expect(model.isBusy("filesystem")).toBe(false);
  });
});

describe("McpPaneModel tool listing", () => {
  function openTools(model: McpPaneModel): void {
    press(model, "enter", "j", "j", "j", "enter");
  }

  it("enter on tools shows a tile-fill loading line and asks the port once", () => {
    const { model, recorded } = modelOver(pair);
    openTools(model);
    expect(recorded.listed).toEqual(["filesystem"]);
    expect(texts(model)).toContain("    ▌ listing tools");
  });

  it("delivered tool names expand inline and are keyboard-navigable", () => {
    const { model } = modelOver(pair);
    openTools(model);
    model.setTools("filesystem", { tools: ["read_file", "write_file", "glob"] });
    expect(texts(model)).toContain("    read_file");
    press(model, "j");
    expect(model.cursorRow()?.id).toBe("tool:filesystem:read_file");
    press(model, "j", "j");
    expect(model.cursorRow()?.id).toBe("tool:filesystem:glob");
    press(model, "enter");
    expect(model.cursorRow()?.id).toBe("tool:filesystem:glob");
  });

  it("a server with zero tools shows a calm dim line", () => {
    const { model } = modelOver(pair);
    openTools(model);
    model.setTools("filesystem", { tools: [] });
    const row = model.rows().find((candidate) => candidate.id === "tools:filesystem:none");
    expect(row?.text).toBe("    no tools");
    expect(row?.tone).toBe("dim");
  });

  it("a listing failure renders a truthful alert line and enter retries", () => {
    const { model, recorded } = modelOver(pair);
    openTools(model);
    model.setTools("filesystem", { error: "transport closed" });
    const failed = model.rows().find((row) => row.id === "tools:filesystem:failed");
    expect(failed?.text).toBe("    ▛ tools unavailable · transport closed");
    expect(failed?.tone).toBe("alert");
    press(model, "j", "enter");
    expect(recorded.listed).toEqual(["filesystem", "filesystem"]);
    expect(texts(model)).toContain("    ▌ listing tools");
    model.setTools("filesystem", { tools: ["read_file"] });
    expect(texts(model)).toContain("    read_file");
  });

  it("closing and reopening loaded tools reuses the cache without refetching", () => {
    const { model, recorded } = modelOver(pair);
    openTools(model);
    model.setTools("filesystem", { tools: ["read_file"] });
    press(model, "enter", "enter");
    expect(texts(model)).toContain("    read_file");
    expect(recorded.listed).toEqual(["filesystem"]);
  });

  it("ignores tool results for servers that no longer exist", () => {
    const { model } = modelOver(pair);
    model.setTools("vanished", { tools: ["ghost"] });
    expect(texts(model).some((text) => text.includes("ghost"))).toBe(false);
  });
});

describe("McpPaneModel refresh under the cursor", () => {
  it("keeps the cursor on the same server when the list reorders and grows", () => {
    const { model } = modelOver(pair);
    press(model, "j");
    expect(model.cursorRow()?.id).toBe("server:linear");
    const reordered: ServerSpec[] = [
      { name: "zeta" },
      { name: "linear", state: "connecting" },
      ...pair.slice(0, 1),
    ];
    model.setServers(reordered.map(serverOf));
    expect(model.cursorRow()?.id).toBe("server:linear");
  });

  it("settles on a selectable row when the cursored server vanishes", () => {
    const { model } = modelOver(pair);
    press(model, "j");
    model.setServers([serverOf({ name: "filesystem" })]);
    expect(model.cursorRow()?.id).toBe("server:filesystem");
  });

  it("drops menu, tools, and cache state for vanished servers", () => {
    const { model, recorded } = modelOver(pair);
    press(model, "enter", "j", "j", "j", "enter");
    model.setTools("filesystem", { tools: ["read_file"] });
    model.setServers([serverOf({ name: "linear", state: "down", lastError: "gone" })]);
    model.setServers(pair.map(serverOf));
    expect(texts(model)).not.toContain("  restart");
    press(model, "k", "enter", "j", "j", "j", "enter");
    expect(recorded.listed).toEqual(["filesystem", "filesystem"]);
  });

  it("a recovering server walks connecting to connected under a held cursor", () => {
    const { model } = modelOver(pair);
    press(model, "j");
    for (const done of [0, 1, 2]) {
      const stage: ServerSpec[] = [
        pair[0] as ServerSpec,
        { name: "linear", state: "connecting", progress: { stagesDone: done, stageCount: 3 } },
      ];
      model.setServers(stage.map(serverOf));
    }
    expect(model.cursorRow()?.text).toBe("▒ linear · ▌▀▗ connecting");
    const recovered: ServerSpec[] = [pair[0] as ServerSpec, { name: "linear", toolCount: 4 }];
    model.setServers(recovered.map(serverOf));
    expect(model.cursorRow()?.text).toBe("█ linear · 4 tools");
  });
});

describe("McpPaneModel navigation edges", () => {
  it("clamps at the top and bottom and skips non-selectable rows", () => {
    const { model } = modelOver(pair);
    press(model, "k", "k");
    expect(model.cursorRow()?.id).toBe("server:filesystem");
    for (let step = 0; step < 20; step += 1) press(model, "j");
    expect(model.cursorRow()?.id).toBe("server:linear");
    press(model, "j");
    expect(model.cursorRow()?.id).toBe("server:linear");
  });

  it("pagedown and pageup land on selectable rows and window the view", () => {
    const many = Array.from({ length: 40 }, (_, at) => ({ name: `srv-${at}` }));
    const { model } = modelOver(many);
    press(model, "pagedown", "pagedown");
    expect(model.cursorRow()?.selectable).toBe(true);
    const visible = model.visibleRows(6);
    expect(visible).toHaveLength(6);
    expect(visible.some(({ index }) => index === model.cursor)).toBe(true);
    press(model, "pageup", "pageup", "pageup");
    expect(model.cursorRow()?.id).toBe("server:srv-0");
  });

  it("cursor always rests on a selectable visible row across random ops", () => {
    const busy = Array.from({ length: 12 }, (_, at) =>
      serverOf({
        name: `srv-${at}`,
        state: (["connected", "connecting", "down"] as const)[at % 3] ?? "connected",
        toolCount: at % 4,
        ...(at % 3 === 2 && { lastError: `boom ${at}` }),
      }),
    );
    const quiet = [serverOf({ name: "srv-1" }), serverOf({ name: "solo" })];
    let alternate = false;
    const model = new McpPaneModel(() => {}, {
      refresh: () => {
        alternate = !alternate;
        model.setServers(alternate ? quiet : busy);
      },
      restart: () => {},
      setEnabled: () => {},
      listTools: (name) => model.setTools(name, { tools: [`${name}-tool`] }),
    });
    model.setServers(busy);
    const ops = ["j", "k", "enter", "h", "r", "pagedown", "pageup", "escape"];
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let step = 0; step < 400; step += 1) {
      press(model, ops[Math.floor(random() * ops.length)] as string);
      const rows = model.rows();
      if (!rows.some((row) => row.selectable)) continue;
      expect(model.cursor).toBeGreaterThanOrEqual(0);
      expect(model.cursor).toBeLessThan(rows.length);
      expect(rows[model.cursor]?.selectable).toBe(true);
      expect(model.visibleRows(5).some(({ index }) => index === model.cursor)).toBe(true);
    }
  });
});
