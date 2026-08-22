import { describe, expect, it } from "vitest";
import { ArcPicker, describeArcRow } from "./arc-picker.ts";
import type { ArcSummary } from "./arcs.ts";
import type { Chord } from "./keys.ts";

const arcs: ArcSummary[] = [
  { slug: "dock-v2", status: "active", created: "2026-08-20T10:00:00.000Z", sessions: 7 },
  { slug: "infra", status: "active", created: "2026-08-21T09:00:00.000Z", sessions: 5 },
  { slug: "old-login", status: "archived", created: "2026-08-01T09:00:00.000Z", sessions: 0 },
];

function key(name: string, sequence?: string): [Chord, string | undefined] {
  return [{ name, ctrl: false, shift: false, meta: false }, sequence];
}

function typed(picker: ArcPicker, text: string): void {
  for (const character of text) picker.handleKey(...key(character, character));
}

describe("ArcPicker", () => {
  it("lists active arcs newest first, archived dimmed last, and starts on the current arc", () => {
    const picker = new ArcPicker(arcs, "dock-v2");
    expect(picker.rows().map(describeArcRow)).toEqual([
      "no arc · release this session",
      "infra · 5 sessions",
      "dock-v2 · 7 sessions · current",
      "old-login · archived",
    ]);
    expect(picker.selected()).toEqual({ kind: "bind", slug: "dock-v2" });
  });

  it("offers no release row when the session is unbound", () => {
    const picker = new ArcPicker(arcs, undefined);
    expect(picker.rows()[0]?.kind).toBe("arc");
    expect(picker.selected()).toEqual({ kind: "bind", slug: "infra" });
  });

  it("wraps with the arrows, chooses on enter, closes on escape", () => {
    const picker = new ArcPicker(arcs, undefined);
    expect(picker.handleKey(...key("up"))).toBe("stay");
    expect(picker.selected()).toEqual({ kind: "archived", slug: "old-login" });
    expect(picker.handleKey(...key("down"))).toBe("stay");
    expect(picker.handleKey(...key("return"))).toBe("choose");
    expect(picker.selected()).toEqual({ kind: "bind", slug: "infra" });
    expect(picker.handleKey(...key("escape"))).toBe("close");
  });

  it("selects a row directly and pastes into the query", () => {
    const picker = new ArcPicker(arcs, "dock-v2");
    picker.select(3);
    expect(picker.selected()).toEqual({ kind: "archived", slug: "old-login" });
    picker.paste("inf");
    expect(picker.rows().map(describeArcRow)).toEqual(["infra · 5 sessions", "new arc inf"]);
    expect(picker.selected()).toEqual({ kind: "bind", slug: "infra" });
  });

  it("filters by typed text and hides the release row while typing", () => {
    const picker = new ArcPicker(arcs, "dock-v2");
    typed(picker, "doc");
    expect(picker.rows().map(describeArcRow)).toEqual([
      "dock-v2 · 7 sessions · current",
      "new arc doc",
    ]);
    expect(picker.selected()).toEqual({ kind: "bind", slug: "dock-v2" });
    picker.handleKey(...key("backspace"));
    expect(picker.query).toBe("do");
  });

  it("turns an unmatched valid slug into a create row", () => {
    const picker = new ArcPicker(arcs, undefined);
    typed(picker, "checkout-flow");
    expect(picker.rows().map(describeArcRow)).toEqual(["new arc checkout-flow"]);
    expect(picker.selected()).toEqual({ kind: "create", slug: "checkout-flow" });
  });

  it("keeps the create row below matching arcs and never duplicates an existing slug", () => {
    const picker = new ArcPicker(arcs, undefined);
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
    const picker = new ArcPicker(arcs, undefined);
    typed(picker, "Dock V2");
    expect(picker.rows()).toEqual([]);
    expect(picker.selected()).toBeUndefined();
  });
});
