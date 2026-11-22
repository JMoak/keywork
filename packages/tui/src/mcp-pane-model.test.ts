import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { McpPaneModel, type McpServerState, type McpServerView } from "./mcp-pane-model.ts";
import { pressModel as press } from "./testing/index.ts";

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

function texts(model: McpPaneModel): string[] {
  return model.rows().map((row) => row.text);
}

const pair: ServerSpec[] = [
  { name: "filesystem", toolCount: 12 },
  { name: "linear", state: "down", toolCount: 0, lastError: "spawn ENOENT: linear-mcp not found" },
];

describe("McpPaneModel status lines", () => {
  it("renders healthy and failing servers with density-ramp glyphs", () => {
    const { model } = modelOver(pair);
    expect(texts(model)).toEqual([
      "█ filesystem · 12 tools",
      "░ linear · ▛",
      "  spawn ENOENT: linear-mcp not found",
    ]);
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
});

describe("McpPaneModel transition holds", () => {
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

  it("a listing failure renders a truthful alert line and enter retries", () => {
    const { model, recorded } = modelOver(pair);
    openTools(model);
    model.setTools("filesystem", { error: "transport closed" });
    const failed = model.rows().find((row) => row.id === "tools:filesystem:failed");
    expect(failed?.text).toBe("    ▛ tools failed · transport closed");
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
});

describe("McpPaneModel navigation edges", () => {
  it("ignores modified chords so ctrl+r is not a refresh", () => {
    const { model, recorded } = modelOver(pair);
    expect(model.handleKey(parseChord("ctrl+r"), 5)).toBe(false);
    expect(model.handleKey(parseChord("shift+j"), 5)).toBe(false);
    expect(model.handleKey(parseChord("alt+enter"), 5)).toBe(false);
    expect(recorded.refreshes).toBe(0);
    expect(model.cursorRow()?.id).toBe("server:filesystem");
    expect(model.rows()).toHaveLength(3);
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

describe("McpPaneModel sign-in rows", () => {
  it("adds an alert row pointing at keywork mcp login when a server needs sign-in", () => {
    const { model } = modelOver([
      {
        name: "github",
        state: "down",
        toolCount: 0,
        lastError: "github wants you to sign in first",
      },
    ]);
    model.setServers([
      {
        ...serverOf({ name: "github", state: "down", toolCount: 0, lastError: "needs sign-in" }),
        transport: "http",
        auth: "sign-in-needed",
      },
    ]);
    expect(texts(model)).toEqual([
      "░ github · ▛ · http",
      "  needs sign-in",
      "  sign in: keywork mcp login github, then restart",
    ]);
    const row = model.rows().find((candidate) => candidate.kind === "sign-in");
    expect(row?.tone).toBe("alert");
    expect(row?.selectable).toBe(false);
  });
});
