import { describe, expect, it } from "vitest";
import { arcChoiceOf, arcPickerOver, arcRowParts, describeArcRow } from "./arc-picker.ts";
import type { ArcSummary } from "./arcs.ts";
import { FilterPicker } from "./filter-picker.ts";
import type { ModelChoice } from "./inference-port.ts";
import type { Chord } from "./keys.ts";
import { describeModelRow, modelPickerOver } from "./model-picker.ts";
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

  it("offers no release row when the session is unbound", () => {
    const picker = arcPickerOver(arcs, undefined);
    expect(picker.rows()[0]?.kind).toBe("arc");
    expect(chosen(picker)).toEqual({ kind: "bind", slug: "infra" });
  });

  it("wraps with the arrows, chooses on enter, closes on escape", () => {
    const picker = arcPickerOver(arcs, undefined);
    expect(picker.handleKey(...key("up"))).toBe("stay");
    expect(chosen(picker)).toEqual({ kind: "archived", slug: "old-login" });
    expect(picker.handleKey(...key("down"))).toBe("stay");
    expect(picker.handleKey(...key("return"))).toBe("choose");
    expect(chosen(picker)).toEqual({ kind: "bind", slug: "infra" });
    expect(picker.handleKey(...key("escape"))).toBe("close");
  });

  it("selects a row directly and pastes into the query", () => {
    const picker = arcPickerOver(arcs, "dock-v2");
    picker.select(3);
    expect(chosen(picker)).toEqual({ kind: "archived", slug: "old-login" });
    picker.paste("inf");
    expect(picker.rows().map(describeArcRow)).toEqual(["infra · 5 sessions", "new arc inf"]);
    expect(chosen(picker)).toEqual({ kind: "bind", slug: "infra" });
  });

  it("filters by typed text and hides the release row while typing", () => {
    const picker = arcPickerOver(arcs, "dock-v2");
    typed(picker, "doc");
    expect(picker.rows().map(describeArcRow)).toEqual([
      "dock-v2 · 7 sessions · current",
      "new arc doc",
    ]);
    expect(chosen(picker)).toEqual({ kind: "bind", slug: "dock-v2" });
    picker.handleKey(...key("backspace"));
    expect(picker.query).toBe("do");
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

  it("splits an arc row into the slug and the facts that follow it", () => {
    const picker = arcPickerOver(arcs, "dock-v2");
    const rows = picker.rows().flatMap((row) => (row.kind === "arc" ? [row] : []));
    expect(rows.map(arcRowParts)).toEqual([
      { slug: "infra", facts: " · 5 sessions" },
      { slug: "dock-v2", facts: " · 7 sessions · current" },
      { slug: "old-login", facts: " · archived" },
    ]);
    for (const row of rows) {
      const { slug, facts } = arcRowParts(row);
      expect(slug + facts).toBe(describeArcRow(row));
    }
  });

  it("describes release and no-session rows", () => {
    const quiet: ArcSummary = {
      slug: "quiet",
      status: "active",
      created: "2026-08-22T00:00:00.000Z",
      sessions: 0,
    };
    const picker = arcPickerOver([quiet], "quiet");
    expect(picker.rows().map(describeArcRow)).toEqual([
      "no arc · release this session",
      "quiet · no sessions · current",
    ]);
    expect(chosen(picker)).toEqual({ kind: "bind", slug: "quiet" });
    picker.select(0);
    expect(chosen(picker)).toEqual({ kind: "release" });
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

  it("says when the default workspace is not set up yet", () => {
    const picker = workspacePickerOver([
      {
        slug: undefined,
        name: "default",
        declared: false,
        current: true,
        notes: 0,
        focusDirs: [],
        sessions: 0,
        lastUsed: undefined,
      },
    ]);
    expect(picker.rows().map(describeWorkspaceRow)).toEqual(["default · not set up yet · current"]);
    expect(chosen(picker)).toEqual({ kind: "use", slug: undefined });
  });

  it("moves, chooses, and closes like every picker", () => {
    const picker = workspacePickerOver(choices);
    expect(picker.handleKey(...key("down"))).toBe("stay");
    expect(chosen(picker)).toEqual({ kind: "use", slug: "infra" });
    expect(picker.handleKey(...key("return"))).toBe("choose");
    expect(picker.handleKey(...key("escape"))).toBe("close");
  });

  it("selects a row directly and pastes into the query", () => {
    const picker = workspacePickerOver(choices);
    picker.select(2);
    expect(chosen(picker)).toEqual({ kind: "use", slug: "infra" });
    picker.paste("front");
    expect(picker.query).toBe("front");
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
  const choices: ModelChoice[] = [
    {
      reference: "ollama/qwen3",
      provider: "ollama",
      model: "qwen3",
      available: true,
      facts: ["chat-completions", "no credential"],
    },
    {
      reference: "openai/gpt-5-mini",
      provider: "openai",
      model: "gpt-5-mini",
      available: true,
      facts: ["chat-completions", "saved key"],
    },
    {
      reference: "openrouter/openai/gpt-5-mini",
      provider: "openrouter",
      model: "openai/gpt-5-mini",
      available: false,
      facts: ["needs a key"],
    },
  ];
  const references = (picker: ReturnType<typeof modelPickerOver>) =>
    picker.rows().map((row) => row.choice.reference);

  it("starts on the current model and marks it", () => {
    const picker = modelPickerOver(choices, "openai/gpt-5-mini");
    expect(picker.rows().map((row) => [row.choice.reference, row.current])).toEqual([
      ["ollama/qwen3", false],
      ["openai/gpt-5-mini", true],
      ["openrouter/openai/gpt-5-mini", false],
    ]);
    expect(picker.cursor()).toBe(1);
  });

  it("wraps with the arrows and chooses on enter", () => {
    const picker = modelPickerOver(choices, undefined);
    expect(picker.handleKey(...key("up"))).toBe("stay");
    expect(picker.selected()?.choice.reference).toBe("openrouter/openai/gpt-5-mini");
    expect(picker.handleKey(...key("down"))).toBe("stay");
    expect(picker.handleKey(...key("return"))).toBe("choose");
    expect(picker.selected()?.choice.reference).toBe("ollama/qwen3");
    expect(picker.handleKey(...key("escape"))).toBe("close");
  });

  it("filters by typed text, keeps order deterministic, and resets the cursor", () => {
    const picker = modelPickerOver(choices, "openrouter/openai/gpt-5-mini");
    typed(picker, "gpt");
    expect(picker.query).toBe("gpt");
    expect(references(picker)).toEqual(["openai/gpt-5-mini", "openrouter/openai/gpt-5-mini"]);
    expect(picker.selected()?.choice.reference).toBe("openai/gpt-5-mini");
    picker.handleKey(...key("backspace"));
    expect(picker.query).toBe("gp");
  });

  it("matches references case-insensitively like every picker", () => {
    const picker = modelPickerOver(choices, undefined);
    typed(picker, "QWEN");
    expect(references(picker)).toEqual(["ollama/qwen3"]);
  });

  it("selects a row directly, clamped to the visible list, and pastes into the query", () => {
    const picker = modelPickerOver(choices, undefined);
    picker.select(2);
    expect(picker.selected()?.choice.reference).toBe("openrouter/openai/gpt-5-mini");
    picker.select(99);
    expect(picker.selected()?.choice.reference).toBe("openrouter/openai/gpt-5-mini");
    picker.paste("qwen");
    expect(picker.query).toBe("qwen");
    expect(picker.selected()?.choice.reference).toBe("ollama/qwen3");
  });

  it("describes a row as reference plus facts, marking the current one", () => {
    const picker = modelPickerOver(choices, "ollama/qwen3");
    expect(picker.rows().map(describeModelRow)).toEqual([
      "ollama/qwen3 · chat-completions · no credential · current",
      "openai/gpt-5-mini · chat-completions · saved key",
      "openrouter/openai/gpt-5-mini · needs a key",
    ]);
  });
});
