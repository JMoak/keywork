import { describe, expect, it } from "vitest";
import type { FrameScheduler } from "./frame-scheduler.ts";
import { parseChord } from "./keys.ts";
import type { PaneIntents } from "./pane.ts";
import { resolveTheme } from "./theme.ts";
import type { WorkspaceChoice, WorkspacesPort } from "./workspace-picker.ts";
import { WorkspacesPane, type WorkspacesPaneOptions } from "./workspaces-pane.ts";

const minute = 60_000;
const now = 60 * minute;

interface World {
  choices: WorkspaceChoice[];
  lists: number;
  created: string[];
  linked: string[];
  unlinked: string[];
  switched: Array<string | undefined>;
  linkFailure: string | undefined;
}

function choice(
  overrides: Partial<WorkspaceChoice> & { slug: string | undefined },
): WorkspaceChoice {
  return {
    name: overrides.slug ?? "default",
    declared: true,
    current: false,
    notes: 0,
    focusDirs: [],
    sessions: 0,
    lastUsed: undefined,
    ...overrides,
  };
}

function worldOf(): World {
  return {
    choices: [
      choice({ slug: undefined, sessions: 1, lastUsed: now - 20 * minute }),
      choice({ slug: "frontend", current: true, focusDirs: ["packages/web"], sessions: 2 }),
    ],
    lists: 0,
    created: [],
    linked: [],
    unlinked: [],
    switched: [],
    linkFailure: undefined,
  };
}

function portOf(world: World): WorkspacesPort {
  return {
    list: async () => {
      world.lists += 1;
      return world.choices;
    },
    create: async (slug) => {
      world.created.push(slug);
      world.choices.push(choice({ slug }));
    },
    use: async () => {},
    linkFocusDir: async (slug, dir) => {
      if (world.linkFailure !== undefined) throw new Error(world.linkFailure);
      world.linked.push(`${slug ?? "default"}:${dir}`);
      return dir;
    },
    unlinkFocusDir: async (slug, dir) => {
      world.unlinked.push(`${slug ?? "default"}:${dir}`);
    },
  };
}

const immediate: FrameScheduler = (frame) => {
  frame();
  return () => {};
};

function paneOf(
  world = worldOf(),
  overrides: Partial<WorkspacesPaneOptions> = {},
): { pane: WorkspacesPane; world: World; notices: string[] } {
  const notices: string[] = [];
  const intents: PaneIntents = {
    openFile: () => {},
    openSession: () => {},
    focusPane: () => {},
    notice: (text) => notices.push(text),
  };
  const pane = new WorkspacesPane("workspaces-1", () => {}, intents, {
    workspaces: portOf(world),
    switchTo: async (slug) => {
      world.switched.push(slug);
    },
    now: () => now,
    scheduleFrame: immediate,
    ...overrides,
  });
  return { pane, world, notices };
}

function press(pane: WorkspacesPane, key: string, sequence?: string): boolean {
  return pane.handleKey(parseChord(key), sequence);
}

function typeText(pane: WorkspacesPane, text: string): void {
  for (const character of text) press(pane, character === "/" ? "slash" : character, character);
}

const theme = resolveTheme();

function rendered(pane: WorkspacesPane): string {
  const view = pane.view({ theme, focused: true, width: 60, height: 12 });
  return JSON.stringify(view);
}

describe("WorkspacesPane", () => {
  it("loads the workspaces, titles itself with the declared count, and describes itself", async () => {
    const { pane } = paneOf();
    await pane.settled();
    expect(pane.title()).toContain("workspaces");
    expect(pane.title()).toContain("2 workspaces");
    expect(pane.describe()).toEqual({ kind: "workspaces" });
    expect(pane.model.rows().map((row) => row.label)).toEqual(["frontend", "default"]);
  });

  it("switches through the seam on enter when nothing is running", async () => {
    const { pane, world } = paneOf();
    await pane.settled();
    press(pane, "j");
    press(pane, "enter");
    await pane.settled();
    expect(world.switched).toEqual([undefined]);
  });

  it("asks first when live turns would be retired", async () => {
    const { pane, world } = paneOf(worldOf(), { liveTurns: () => 2 });
    await pane.settled();
    press(pane, "j");
    press(pane, "enter");
    expect(world.switched).toEqual([]);
    expect(rendered(pane)).toContain("switch to default? 2 turns still running here");
    press(pane, "enter");
    await pane.settled();
    expect(world.switched).toEqual([undefined]);
  });

  it("creates a workspace from the inline name and reloads", async () => {
    const { pane, world, notices } = paneOf();
    await pane.settled();
    press(pane, "n");
    typeText(pane, "mobile");
    expect(rendered(pane)).toContain("new workspace: mobile");
    press(pane, "enter");
    await pane.settled();
    expect(world.created).toEqual(["mobile"]);
    expect(notices).toEqual(["workspace mobile ready · enter on it switches"]);
    expect(pane.model.rows().map((row) => row.label)).toEqual(["frontend", "default", "mobile"]);
  });

  it("links and unlinks focus dirs through the port, reporting failures as notices", async () => {
    const { pane, world, notices } = paneOf();
    await pane.settled();
    press(pane, "l");
    typeText(pane, "packages/ui");
    press(pane, "enter");
    await pane.settled();
    expect(world.linked).toEqual(["frontend:packages/ui"]);
    expect(notices.at(-1)).toBe("packages/ui is now a focus dir of frontend");

    press(pane, "x");
    expect(pane.title()).toContain("frontend");
    expect(pane.title()).toContain("1 focus dir");
    press(pane, "x");
    await pane.settled();
    expect(world.unlinked).toEqual(["frontend:packages/web"]);

    world.linkFailure = "nope isn't a directory";
    press(pane, "l");
    typeText(pane, "nope");
    press(pane, "enter");
    await pane.settled();
    expect(notices.at(-1)).toBe("nope isn't a directory");
    expect(pane.view({ theme, focused: true, width: 60, height: 12 })).toBeDefined();
  });

  it("opens the tray on its key and lists the level's commands", async () => {
    const { pane } = paneOf();
    await pane.settled();
    expect(pane.tray.open).toBe(false);
    press(pane, "/", "/");
    expect(pane.tray.open).toBe(true);
    expect(pane.tray.matches().map((command) => command.name)).toEqual([
      "switch",
      "new",
      "link",
      "focus",
      "refresh",
    ]);
  });

  it("selects a row from a click at the workspaces level", async () => {
    const { pane } = paneOf();
    await pane.settled();
    pane.view({ theme, focused: true, width: 60, height: 12 });
    expect(pane.handleMouse({ x: 2, y: 2 }, { type: "down", x: 2, y: 2, button: 0 })).toBe(true);
    expect(pane.model.cursorRow()?.label).toBe("default");
  });
});
