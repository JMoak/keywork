import { describe, expect, it } from "vitest";
import type { CuringStage, MemoryNoteView } from "./memory-pane-model.ts";
import { curingGlyph, findNote, focusRows, overviewRows, provenanceGlyph } from "./memory-rows.ts";

function noteOf(name: string, extra: Partial<MemoryNoteView> = {}): MemoryNoteView {
  return {
    name,
    title: name,
    scope: "workspace",
    provenance: "agent",
    curing: 3,
    links: [],
    aliases: [],
    ...extra,
  };
}

describe("memory glyphs", () => {
  it("maps the provenance ramp densest-first: user, agent, untrusted", () => {
    expect(provenanceGlyph("user")).toBe("█");
    expect(provenanceGlyph("agent")).toBe("▓");
    expect(provenanceGlyph("untrusted")).toBe("░");
  });

  it("walks the density ramp with the curing stage", () => {
    expect([0, 1, 2, 3].map((stage) => curingGlyph(stage as CuringStage))).toEqual([
      "░",
      "▒",
      "▓",
      "█",
    ]);
  });
});

describe("findNote", () => {
  it("resolves a reference by name, title, or alias, case-insensitively", () => {
    const notes = [noteOf("ratio-rule", { title: "Ratio Rule", aliases: ["ratios"] })];
    expect(findNote(notes, "RATIO-RULE")?.name).toBe("ratio-rule");
    expect(findNote(notes, "ratio rule")?.name).toBe("ratio-rule");
    expect(findNote(notes, " ratios ")?.name).toBe("ratio-rule");
    expect(findNote(notes, "")).toBeUndefined();
    expect(findNote(notes, "nowhere")).toBeUndefined();
  });
});

describe("overviewRows", () => {
  it("orders the sections scopes, inbox, garden, recalls with stable ids", () => {
    const rows = overviewRows({
      scopes: ["workspace"],
      notes: [noteOf("a")],
      inbox: [{ id: "i1", kind: "staged", title: "t", provenance: "user", created: "2026" }],
      recalls: [{ note: "a", scope: "workspace", provenance: "agent" }],
      gardener: { state: "idle" },
    });
    expect(rows.map((row) => row.id)).toEqual([
      "header:scopes",
      "scope:workspace",
      "header:inbox ░1",
      "inbox:i1",
      "header:garden",
      "gardener",
      "note:a",
      "header:recalls",
      "recall:0:a",
    ]);
    expect(rows.filter((row) => row.selectable).map((row) => row.id)).toEqual([
      "inbox:i1",
      "note:a",
      "recall:0:a",
    ]);
  });

  it("derives scopes from the notes when none are declared", () => {
    const rows = overviewRows({
      scopes: [],
      notes: [noteOf("a", { scope: "user" }), noteOf("b"), noteOf("c", { scope: "user" })],
      inbox: [],
      recalls: [],
    });
    expect(rows.filter((row) => row.kind === "scope").map((row) => row.text)).toEqual([
      "user · 2 notes",
      "workspace · 1 note",
    ]);
  });
});

describe("focusRows", () => {
  it("lists a calm no-links line when the note links nowhere and nothing links in", () => {
    const focus = noteOf("loner");
    expect(focusRows([focus], focus).map((row) => row.text)).toEqual([
      "note · loner",
      "█▓ loner",
      "no links yet",
    ]);
  });

  it("omits the links-out section when only backlinks exist", () => {
    const focus = noteOf("target");
    const rows = focusRows([focus, noteOf("source", { links: ["target"] })], focus);
    expect(rows.map((row) => row.text)).toEqual([
      "note · target",
      "█▓ target",
      "links in",
      "  █▓ source",
    ]);
  });
});
