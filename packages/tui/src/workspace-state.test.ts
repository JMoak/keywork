import { describe, expect, it } from "vitest";
import { Layout } from "./layout.ts";
import type { Pane, PaneDescriptor } from "./pane.ts";
import { captureWorkspace, parseWorkspaceState } from "./workspace-state.ts";

const screen = { width: 120, height: 40 };

function paneOf(id: string, descriptor?: PaneDescriptor): Pane {
  return {
    id,
    title: () => id,
    view: () => {
      throw new Error("never rendered");
    },
    ...(descriptor !== undefined && { describe: () => descriptor }),
  };
}

function workspaceOf(...panes: Array<[string, PaneDescriptor | undefined]>) {
  const layout = new Layout();
  const byId = new Map<string, Pane>();
  for (const [id, descriptor] of panes) {
    layout.open(id, screen);
    byId.set(id, paneOf(id, descriptor));
  }
  return { layout, panes: byId };
}

describe("captureWorkspace", () => {
  it("captures descriptors for every describable pane in layout order", () => {
    const { layout, panes } = workspaceOf(
      ["session-1", { kind: "conversation", sessionId: "abc" }],
      ["file-1", { kind: "file", path: "src/main.ts" }],
      ["browser-1", { kind: "browser", root: "/repo" }],
    );
    layout.focus("browser-1");
    layout.dockFocused("left", screen);

    const state = captureWorkspace(layout, panes);

    expect(state.version).toBe(2);
    expect(state.panes).toEqual([
      { id: "browser-1", kind: "browser", root: "/repo" },
      { id: "session-1", kind: "conversation", sessionId: "abc" },
      { id: "file-1", kind: "file", path: "src/main.ts" },
    ]);
    expect(state.layout.docks?.left?.panes).toEqual(["browser-1"]);
    expect(state.layout.docks?.right).toBeUndefined();
  });

  it("omits panes that cannot describe themselves", () => {
    const { layout, panes } = workspaceOf(
      ["session-1", { kind: "conversation" }],
      ["mystery-1", undefined],
    );
    expect(captureWorkspace(layout, panes).panes).toEqual([
      { id: "session-1", kind: "conversation" },
    ]);
  });
});

describe("parseWorkspaceState", () => {
  const valid = () => {
    const { layout, panes } = workspaceOf(
      ["session-1", { kind: "conversation", sessionId: "abc" }],
      ["file-1", { kind: "file", path: "notes.md" }],
    );
    return JSON.parse(JSON.stringify(captureWorkspace(layout, panes))) as unknown;
  };

  it("accepts its own capture output", () => {
    const state = parseWorkspaceState(valid());
    expect(state?.panes).toHaveLength(2);
    expect(state?.layout.focused).toBe("file-1");
  });

  it("discards wholesale on unknown versions", () => {
    const state = valid() as { version: number };
    state.version = 3;
    expect(parseWorkspaceState(state)).toBeUndefined();
    state.version = 0;
    expect(parseWorkspaceState(state)).toBeUndefined();
  });

  it("migrates a v1 state losslessly: the single dock becomes its side, the other stays empty", () => {
    const v1 = {
      version: 1,
      layout: {
        tree: { kind: "leaf", id: "session-1" },
        focused: "browser-1",
        dock: { side: "left", panes: ["browser-1"], ratio: 0.25 },
      },
      panes: [
        { id: "session-1", kind: "conversation", sessionId: "abc" },
        { id: "browser-1", kind: "browser", root: "/repo" },
      ],
    };
    const state = parseWorkspaceState(JSON.parse(JSON.stringify(v1)));
    expect(state?.version).toBe(2);
    expect(state?.layout.docks).toEqual({ left: { panes: ["browser-1"], ratio: 0.25 } });
    expect(state?.layout.tree).toEqual({ kind: "leaf", id: "session-1" });
    expect(state?.layout.focused).toBe("browser-1");
    expect(state?.panes).toEqual([
      { id: "session-1", kind: "conversation", sessionId: "abc" },
      { id: "browser-1", kind: "browser", root: "/repo" },
    ]);
  });

  it("migrates a right-docked v1 state to the right dock", () => {
    const state = parseWorkspaceState({
      version: 1,
      layout: {
        tree: { kind: "leaf", id: "session-1" },
        dock: { side: "right", panes: ["mcp-1"], ratio: 1 / 3 },
      },
      panes: [
        { id: "session-1", kind: "conversation" },
        { id: "mcp-1", kind: "mcp" },
      ],
    });
    expect(state?.layout.docks).toEqual({ right: { panes: ["mcp-1"], ratio: 1 / 3 } });
    expect(state?.layout.docks?.left).toBeUndefined();
  });

  it("discards wholesale on unknown pane kinds, bad fields, or stray ids", () => {
    const withPane = (pane: unknown) => {
      const state = valid() as { panes: unknown[] };
      state.panes[1] = pane;
      return state;
    };
    const corrupt: unknown[] = [
      undefined,
      null,
      "state",
      { version: 1 },
      withPane({ id: "file-1", kind: "hologram" }),
      withPane({ id: "file-1", kind: "file", path: "" }),
      withPane({ id: "file-1", kind: "browser" }),
      withPane({ id: "ghost-1", kind: "file", path: "notes.md" }),
      withPane({ id: "session-1", kind: "conversation" }),
      withPane({ id: "session-1", kind: "conversation", sessionId: 7 }),
    ];
    for (const value of corrupt) expect(parseWorkspaceState(value)).toBeUndefined();
  });

  it("allows layout panes with no descriptor to be pruned later", () => {
    const state = valid() as { panes: unknown[] };
    state.panes.pop();
    const parsed = parseWorkspaceState(state);
    expect(parsed?.panes).toEqual([{ id: "session-1", kind: "conversation", sessionId: "abc" }]);
  });
});
