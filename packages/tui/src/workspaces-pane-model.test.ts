import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import type { WorkspaceChoice } from "./workspace-picker.ts";
import {
  describeSwitch,
  WorkspacesPaneModel,
  type WorkspacesPaneSeams,
  workspaceLine,
} from "./workspaces-pane-model.ts";

interface Recorded {
  refreshes: number;
  activated: Array<string | undefined>;
  created: string[];
  linked: string[];
  unlinked: string[];
  rejected: string[];
}

const minute = 60_000;
const now = 60 * minute;

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

const choices: WorkspaceChoice[] = [
  choice({ slug: undefined, sessions: 3, lastUsed: now - 30 * minute }),
  choice({
    slug: "frontend",
    current: true,
    focusDirs: ["packages/web", "packages/ui"],
    sessions: 2,
    lastUsed: now - 5 * minute,
  }),
  choice({ slug: "infra", sessions: 1, lastUsed: now - 2 * minute }),
  choice({ slug: "stale", declared: false }),
];

function modelOf(
  seams: WorkspacesPaneSeams = {},
  items = choices,
): { model: WorkspacesPaneModel; recorded: Recorded } {
  const recorded: Recorded = {
    refreshes: 0,
    activated: [],
    created: [],
    linked: [],
    unlinked: [],
    rejected: [],
  };
  const model = new WorkspacesPaneModel(
    () => {},
    {
      refresh: () => {
        recorded.refreshes += 1;
      },
      activate: (slug) => recorded.activated.push(slug),
      create: (slug) => recorded.created.push(slug),
      link: (slug, dir) => recorded.linked.push(`${slug ?? "default"}:${dir}`),
      unlink: (slug, dir) => recorded.unlinked.push(`${slug ?? "default"}:${dir}`),
      reject: (reason) => recorded.rejected.push(reason),
    },
    { now: () => now, ...seams },
  );
  model.setChoices(items);
  return { model, recorded };
}

function press(model: WorkspacesPaneModel, key: string, sequence?: string): boolean {
  return model.handleKey(parseChord(key), 10, sequence);
}

function typeText(model: WorkspacesPaneModel, text: string): void {
  for (const character of text) press(model, character === "/" ? "slash" : character, character);
}

describe("WorkspacesPaneModel rows", () => {
  it("puts the current workspace first, then most recently used, undeclared last", () => {
    const { model } = modelOf();
    expect(model.rows().map(workspaceLine)).toEqual([
      "▓ frontend · packages/web, packages/ui · 2 sessions · 5m",
      "░ infra · 1 session · 2m",
      "░ default · 3 sessions · 30m",
      "░ stale · not set up yet",
    ]);
  });
});

describe("WorkspacesPaneModel keys", () => {
  it("enter on another workspace switches straight away when nothing is running", () => {
    const { model, recorded } = modelOf();
    press(model, "j");
    press(model, "enter");
    expect(recorded.activated).toEqual(["infra"]);
    expect(model.pendingSwitch).toBeUndefined();
  });

  it("asks before a switch that would retire running turns, enter confirms, esc keeps", () => {
    const { model, recorded } = modelOf({ liveTurns: () => 1 });
    press(model, "j");
    press(model, "j");
    press(model, "enter");
    expect(recorded.activated).toEqual([]);
    expect(model.pendingSwitch).toMatchObject({ slug: undefined, label: "default", liveTurns: 1 });
    expect(
      describeSwitch(model.pendingSwitch ?? { slug: undefined, label: "", liveTurns: 0 }),
    ).toBe("switch to default? 1 turn still running here · enter switches · esc keeps");

    press(model, "escape");
    expect(model.pendingSwitch).toBeUndefined();
    expect(recorded.activated).toEqual([]);

    press(model, "enter");
    press(model, "enter");
    expect(recorded.activated).toEqual([undefined]);
    expect(model.pendingSwitch).toBeUndefined();
  });

  it("names a new workspace inline and validates the slug before creating", () => {
    const { model, recorded } = modelOf();
    press(model, "n");
    expect(model.draft).toEqual({ kind: "name", text: "" });
    typeText(model, "Bad Name");
    press(model, "enter");
    expect(recorded.created).toEqual([]);
    expect(recorded.rejected.at(-1)).toContain("isn't a workspace slug");

    press(model, "n");
    typeText(model, "frontend");
    press(model, "enter");
    expect(recorded.rejected.at(-1)).toBe("a workspace named frontend already exists");

    press(model, "n");
    typeText(model, "default");
    press(model, "enter");
    expect(recorded.rejected.at(-1)).toContain("isn't a workspace slug");

    press(model, "n");
    typeText(model, "mobile-app");
    press(model, "backspace");
    press(model, "enter");
    expect(recorded.created).toEqual(["mobile-ap"]);
    expect(model.draft).toBeUndefined();
  });

  it("l links a focus dir to the cursored workspace, refusing one that is not set up", () => {
    const { model, recorded } = modelOf();
    press(model, "l");
    typeText(model, "packages/api");
    press(model, "enter");
    expect(recorded.linked).toEqual(["frontend:packages/api"]);

    press(model, "end");
    press(model, "l");
    expect(model.draft).toBeUndefined();
    expect(recorded.rejected.at(-1)).toBe("stale isn't set up yet · /init declares it first");
  });

  it("x drills into the focus dirs, where x unlinks the cursored one and esc returns", () => {
    const { model, recorded } = modelOf();
    press(model, "x");
    expect(model.level()).toBe("focus");
    expect(model.drilled()?.label).toBe("frontend");
    expect(model.focus.rows().map((row) => row.dir)).toEqual(["packages/web", "packages/ui"]);

    press(model, "j");
    press(model, "x");
    expect(recorded.unlinked).toEqual(["frontend:packages/ui"]);

    press(model, "l");
    typeText(model, "packages/cli");
    press(model, "enter");
    expect(recorded.linked).toEqual(["frontend:packages/cli"]);

    press(model, "escape");
    expect(model.level()).toBe("workspaces");
  });
});
