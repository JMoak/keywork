import { describe, expect, it } from "vitest";
import { arcChoiceOf, arcPickerOver, describeArcRow } from "./arc-picker.ts";
import type { ArcSummary } from "./arcs.ts";
import { FilterPicker } from "./filter-picker.ts";
import type { ModelChoice } from "./inference-port.ts";
import type { Chord } from "./keys.ts";
import { modelPickerOver } from "./model-picker.ts";
import { rankByFuzzy } from "./picker-keys.ts";
import {
  describeWorkspaceRow,
  type WorkspaceChoice,
  workspaceChoiceOf,
  workspacePickerOver,
} from "./workspace-picker.ts";

function key(name: string, sequence?: string): [Chord, string | undefined] {
  return [{ name, ctrl: false, shift: false, meta: false }, sequence];
}

function typed(picker: FilterPicker<unknown>, text: string): void {
  for (const character of text) picker.handleKey(...key(character, character));
}

describe("FilterPicker", () => {
  const names = ["alpha", "beta", "gamma"];
  const over = (source: () => string[]) =>
    new FilterPicker((needle) => rankByFuzzy(source(), needle, (name) => name));

  it("starts on the row the caller points at, or the first one", () => {
    const picker = new FilterPicker(
      () => names,
      (name) => name === "beta",
    );
    expect(picker.selected()).toBe("beta");
    expect(picker.cursor()).toBe(1);
    expect(new FilterPicker(() => names).selected()).toBe("alpha");
  });

  it("wraps in both directions with arrows and tab", () => {
    const picker = over(() => names);
    picker.handleKey(...key("up"));
    expect(picker.selected()).toBe("gamma");
    picker.handleKey(...key("down"));
    expect(picker.selected()).toBe("alpha");
    picker.handleKey(...key("tab"));
    expect(picker.selected()).toBe("beta");
    picker.handleKey({ name: "tab", ctrl: false, shift: true, meta: false }, undefined);
    expect(picker.selected()).toBe("alpha");
  });

  it("clamps the cursor when the rows shrink under it", () => {
    let rows = names;
    const picker = over(() => rows);
    picker.select(2);
    rows = ["alpha"];
    expect(picker.cursor()).toBe(0);
    expect(picker.selected()).toBe("alpha");
    rows = [];
    expect(picker.cursor()).toBe(0);
    expect(picker.selected()).toBeUndefined();
    picker.handleKey(...key("down"));
    expect(picker.selected()).toBeUndefined();
    rows = names;
    expect(picker.selected()).toBe("alpha");
  });

  it("resets the cursor on every query change and trims the needle", () => {
    const picker = over(() => names);
    picker.select(2);
    typed(picker, " GA");
    expect(picker.query).toBe(" GA");
    expect(picker.rows()).toEqual(["gamma"]);
    expect(picker.selected()).toBe("gamma");
    picker.handleKey(...key("backspace"));
    expect(picker.query).toBe(" G");
    expect(picker.rows()).toEqual(["gamma"]);
  });

  it("pastes onto the query, selects directly with clamping, and reports outcomes", () => {
    const picker = over(() => names);
    picker.paste("be");
    expect(picker.query).toBe("be");
    expect(picker.selected()).toBe("beta");
    picker.retype("");
    picker.select(99);
    expect(picker.selected()).toBe("gamma");
    picker.select(-4);
    expect(picker.selected()).toBe("alpha");
    expect(picker.handleKey(...key("return"))).toBe("choose");
    expect(picker.handleKey(...key("escape"))).toBe("close");
    expect(picker.handleKey(...key("pagedown"))).toBe("stay");
  });

  describe("paging", () => {
    const letters = Array.from({ length: 10 }, (_, at) => String.fromCharCode(97 + at));
    const shown = (picker: FilterPicker<string>, room: number) =>
      picker
        .page(room)
        .rows.map(({ row, selected }) => (selected ? row.toUpperCase() : row))
        .join("");

    it("shows the first rows with the cursor on top and counts what is hidden below", () => {
      const picker = over(() => letters);
      expect(shown(picker, 4)).toBe("Abcd");
      expect(picker.page(4)).toMatchObject({ above: 0, below: 6 });
      expect(picker.page(4).rows.map((visible) => visible.index)).toEqual([0, 1, 2, 3]);
    });

    it("scrolls only when the cursor leaves the window, then holds still inside it", () => {
      const picker = over(() => letters);
      for (let step = 0; step < 5; step += 1) picker.move(1);
      expect(shown(picker, 4)).toBe("cdeF");
      expect(picker.page(4)).toMatchObject({ above: 2, below: 4 });
      picker.move(-1);
      picker.move(-1);
      expect(shown(picker, 4)).toBe("cDef");
      picker.move(-1);
      picker.move(-1);
      expect(shown(picker, 4)).toBe("Bcde");
    });
  });
});

describe("arc picker", () => {
  const arcs: ArcSummary[] = [
    { slug: "dock-v2", status: "active", created: "2026-08-20T10:00:00.000Z", sessions: 7 },
    { slug: "infra", status: "active", created: "2026-08-21T09:00:00.000Z", sessions: 5 },
    { slug: "old-login", status: "archived", created: "2026-08-01T09:00:00.000Z", sessions: 0 },
  ];
  const chosen = (picker: ReturnType<typeof arcPickerOver>) => {
    const row = picker.selected();
    return row === undefined ? undefined : arcChoiceOf(row);
  };

  it("lists active arcs newest first, archived last, and starts on the current arc", () => {
    const picker = arcPickerOver(arcs, "dock-v2");
    expect(picker.rows().map(describeArcRow)).toEqual([
      "no arc · release this session",
      "infra · 5 sessions",
      "dock-v2 · 7 sessions · current",
      "old-login · archived",
    ]);
    expect(chosen(picker)).toEqual({ kind: "bind", slug: "dock-v2" });
  });

  it("turns an unmatched valid slug into a create row", () => {
    const picker = arcPickerOver(arcs, undefined);
    typed(picker, "checkout-flow");
    expect(picker.rows().map(describeArcRow)).toEqual(["new arc checkout-flow"]);
    expect(chosen(picker)).toEqual({ kind: "create", slug: "checkout-flow" });
  });

  it("keeps the create row below matching arcs and never duplicates an existing slug", () => {
    const picker = arcPickerOver(arcs, undefined);
    typed(picker, "in");
    expect(picker.rows().map(describeArcRow)).toEqual([
      "infra · 5 sessions",
      "new arc in",
      "old-login · archived",
    ]);
    typed(picker, "fra");
    expect(picker.rows().map(describeArcRow)).toEqual(["infra · 5 sessions"]);
  });

  it("offers no create row for text that is not a slug", () => {
    const picker = arcPickerOver(arcs, undefined);
    typed(picker, "Dock V2");
    expect(picker.rows()).toEqual([]);
    expect(chosen(picker)).toBeUndefined();
  });
});

describe("workspace picker", () => {
  const choices: WorkspaceChoice[] = [
    {
      slug: undefined,
      name: "keywork",
      declared: true,
      current: false,
      notes: 12,
      focusDirs: [],
      sessions: 0,
      lastUsed: undefined,
    },
    {
      slug: "frontend",
      name: "Frontend revamp",
      declared: true,
      current: true,
      notes: 0,
      focusDirs: [],
      sessions: 0,
      lastUsed: undefined,
    },
    {
      slug: "infra",
      name: "infra",
      declared: true,
      current: false,
      notes: 1,
      focusDirs: [],
      sessions: 0,
      lastUsed: undefined,
    },
  ];
  const chosen = (picker: ReturnType<typeof workspacePickerOver>) => {
    const row = picker.selected();
    return row === undefined ? undefined : workspaceChoiceOf(row);
  };

  it("lists the default first, names the rest, and starts on the current workspace", () => {
    const picker = workspacePickerOver(choices);
    expect(picker.rows().map(describeWorkspaceRow)).toEqual([
      "default · 12 memory files",
      "frontend · Frontend revamp · empty vault · current",
      "infra · 1 memory file",
    ]);
    expect(chosen(picker)).toEqual({ kind: "use", slug: "frontend" });
  });

  it("filters by slug and offers to create an unknown slug", () => {
    const picker = workspacePickerOver(choices);
    typed(picker, "in");
    expect(picker.rows().map(describeWorkspaceRow)).toEqual([
      "infra · 1 memory file",
      "new workspace in",
    ]);
    typed(picker, "fra-v2");
    expect(picker.rows().map(describeWorkspaceRow)).toEqual(["new workspace infra-v2"]);
    expect(chosen(picker)).toEqual({ kind: "create", slug: "infra-v2" });
  });

  it("never offers to create default or a non-slug", () => {
    const picker = workspacePickerOver(choices);
    typed(picker, "default");
    expect(picker.rows().map(describeWorkspaceRow)).toEqual(["default · 12 memory files"]);
    const other = workspacePickerOver(choices);
    typed(other, "Bad Name");
    expect(other.rows()).toEqual([]);
  });
});

describe("model picker", () => {
  const references = (picker: ReturnType<typeof modelPickerOver>) =>
    picker.rows().map((row) => row.choice.reference);

  it("ranks usable models ahead of matches that cannot run, keeping fuzzy order within each", () => {
    const catalogue: ModelChoice[] = [
      {
        reference: "openai/gpt-5-mini",
        provider: "openai",
        model: "gpt-5-mini",
        available: false,
        facts: ["needs KEYWORK_OPENAI_API_KEY"],
      },
      {
        reference: "openai/gpt-5.4-mini",
        provider: "openai",
        model: "gpt-5.4-mini",
        available: false,
        facts: ["needs KEYWORK_OPENAI_API_KEY"],
      },
      {
        reference: "openrouter/openai/gpt-5-mini",
        provider: "openrouter",
        model: "openai/gpt-5-mini",
        available: true,
        facts: ["saved key"],
      },
      {
        reference: "openrouter/openai/gpt-5.4-mini",
        provider: "openrouter",
        model: "openai/gpt-5.4-mini",
        available: true,
        facts: ["saved key"],
      },
    ];
    const picker = modelPickerOver(catalogue, undefined);
    typed(picker, "gpt-5-mini");
    expect(references(picker)).toEqual([
      "openrouter/openai/gpt-5-mini",
      "openrouter/openai/gpt-5.4-mini",
      "openai/gpt-5-mini",
      "openai/gpt-5.4-mini",
    ]);
    expect(picker.selected()?.choice.reference).toBe("openrouter/openai/gpt-5-mini");
  });
});
