import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import {
  type CuringStage,
  curingGlyph,
  emptyMemoryInputs,
  gardenerSweepView,
  type InboxItemView,
  type MemoryNoteView,
  type MemoryPaneInputs,
  MemoryPaneModel,
  type MemoryProvenance,
  provenanceGlyph,
  type RecallEventView,
  recallView,
  toneToken,
} from "./memory-pane-model.ts";
import { resolveTheme } from "./theme.ts";

interface NoteSpec {
  name: string;
  scope?: string;
  provenance?: MemoryProvenance;
  curing?: CuringStage;
  links?: string[];
  aliases?: string[];
  supersededBy?: string;
}

function noteOf(spec: NoteSpec): MemoryNoteView {
  return {
    name: spec.name,
    title: spec.name,
    scope: spec.scope ?? "workspace",
    provenance: spec.provenance ?? "agent",
    curing: spec.curing ?? 3,
    links: spec.links ?? [],
    aliases: spec.aliases ?? [],
    ...(spec.supersededBy !== undefined && { supersededBy: spec.supersededBy }),
  };
}

function inboxOf(id: string, overrides: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id,
    kind: "staged",
    title: `item ${id}`,
    provenance: "untrusted",
    created: `2026-08-10T00:00:0${id.length % 10}Z`,
    ...overrides,
  };
}

interface Recorded {
  refreshes: number;
  approved: string[];
  discarded: string[];
}

function modelOver(inputs: Partial<MemoryPaneInputs>) {
  const recorded: Recorded = { refreshes: 0, approved: [], discarded: [] };
  const model = new MemoryPaneModel(() => {}, {
    refresh: () => {
      recorded.refreshes += 1;
    },
    approve: (id) => recorded.approved.push(id),
    discard: (id) => recorded.discarded.push(id),
  });
  model.setInputs({ ...emptyMemoryInputs, scopes: ["workspace", "user"], ...inputs });
  return { model, recorded };
}

function press(model: MemoryPaneModel, ...specs: string[]): void {
  for (const spec of specs) model.handleKey(parseChord(spec), 5);
}

function texts(model: MemoryPaneModel): string[] {
  return model.rows().map((row) => row.text);
}

const garden: NoteSpec[] = [
  { name: "ratio-resize-decision", provenance: "user", curing: 3, links: ["split-ratios"] },
  {
    name: "split-ratios",
    provenance: "agent",
    curing: 3,
    links: ["ratio-resize-decision", "layout-engine"],
    supersededBy: "ratio-resize-decision",
  },
  { name: "tests-run-on-node", provenance: "agent", curing: 0, aliases: ["node-tests"] },
  { name: "layout-engine", scope: "user", provenance: "user", curing: 2, links: ["missing-note"] },
];

describe("MemoryPaneModel zero-memory state", () => {
  it("renders a calm invitation instead of empty sections", () => {
    const { model } = modelOver({});
    expect(texts(model)).toEqual(["nothing remembered yet", "workspace · user"]);
    expect(model.rows().every((row) => row.tone === "dim" && !row.selectable)).toBe(true);
  });

  it("navigation on the calm state never throws or moves anywhere", () => {
    const { model, recorded } = modelOver({});
    press(model, "j", "k", "enter", "a", "d", "i", "g", "pagedown", "h");
    expect(model.cursor).toBe(0);
    expect(recorded.approved).toEqual([]);
    expect(recorded.discarded).toEqual([]);
  });
});

describe("MemoryPaneModel overview sections", () => {
  it("shows scopes at a glance with note and fresh counts", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    expect(texts(model)).toContain("workspace · 3 notes · 1 fresh");
    expect(texts(model)).toContain("user · 1 note");
  });

  it("renders notes with curing glyph, provenance glyph, and ~ prefix when fresh", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    expect(texts(model)).toContain("░▓ ~tests-run-on-node");
    expect(texts(model)).toContain("█▓ split-ratios → ratio-resize-decision");
    expect(texts(model)).toContain("██ ratio-resize-decision");
    expect(texts(model)).toContain("▓█ layout-engine");
  });

  it("keeps fresh and cured notes on distinct theme tokens in light and dark themes", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    const byText = new Map(model.rows().map((row) => [row.text, row]));
    const fresh = byText.get("░▓ ~tests-run-on-node");
    const cured = byText.get("██ ratio-resize-decision");
    expect(fresh?.tone).toBe("dim");
    expect(cured?.tone).toBe("normal");
    const dark = resolveTheme();
    const light = resolveTheme({ text: "#24292f", textDim: "#8c959f", background: "#ffffff" });
    for (const theme of [dark, light]) {
      expect(theme[toneToken("dim")]).not.toBe(theme[toneToken("normal")]);
    }
  });

  it("dims superseded notes and appends their successor", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    const row = model.rows().find((candidate) => candidate.text.includes("split-ratios →"));
    expect(row?.tone).toBe("dim");
  });

  it("maps the provenance ramp densest-first: user, agent, untrusted", () => {
    expect(provenanceGlyph("user")).toBe("█");
    expect(provenanceGlyph("agent")).toBe("▓");
    expect(provenanceGlyph("untrusted")).toBe("░");
    expect([0, 1, 2, 3].map((stage) => curingGlyph(stage as CuringStage))).toEqual([
      "░",
      "▒",
      "▓",
      "█",
    ]);
  });

  it("renders recent recalls with provenance, scope, and annotation", () => {
    const recalls: RecallEventView[] = [
      { note: "split-ratios", scope: "workspace", provenance: "agent" },
      {
        note: "layout-engine",
        scope: "user",
        provenance: "user",
        annotation: "predates this session's discussion",
      },
    ];
    const { model } = modelOver({ notes: garden.map(noteOf), recalls });
    expect(texts(model)).toContain("▓ split-ratios · workspace");
    expect(texts(model)).toContain("█ layout-engine · user · predates this session's discussion");
  });

  it("caps the recall list at the most recent eight", () => {
    const recalls = Array.from({ length: 30 }, (_, at) => ({
      note: `note-${at}`,
      scope: "workspace",
      provenance: "agent" as const,
    }));
    const { model } = modelOver({ notes: garden.map(noteOf), recalls });
    const recallRows = model.rows().filter((row) => row.kind === "recall");
    expect(recallRows).toHaveLength(8);
    expect(recallRows.at(-1)?.text).toContain("note-29");
  });

  it("shows the gardener tile-fill line: idle holds, phases fill, failure gaps", () => {
    const notes = garden.map(noteOf);
    const idle = modelOver({ notes, gardener: { state: "idle" } }).model;
    expect(texts(idle)).toContain("gardener █ idle");
    const working = modelOver({
      notes,
      gardener: { state: "working", phasesDone: 2, phaseCount: 3, detail: "merging duplicates" },
    }).model;
    expect(texts(working)).toContain("gardener ▌▀▗ · merging duplicates");
    const failed = modelOver({ notes, gardener: { state: "failed", detail: "sweep crashed" } });
    const failedRow = failed.model.rows().find((row) => row.kind === "gardener");
    expect(failedRow?.text).toBe("gardener ▛ · sweep crashed");
    expect(failedRow?.tone).toBe("alert");
  });

  it("survives unicode-wide titles without corrupting row structure", () => {
    const wide = noteOf({ name: "日本語のとても長いタイトルのノート測定テスト", curing: 1 });
    const { model } = modelOver({ notes: [wide] });
    const row = model.rows().find((candidate) => candidate.kind === "note");
    expect(row?.text).toContain("~日本語のとても長いタイトルのノート測定テスト");
    expect(row?.selectable).toBe(true);
  });
});

describe("MemoryPaneModel review inbox", () => {
  const inbox: InboxItemView[] = [
    inboxOf("c", {
      kind: "contradiction",
      title: "pnpm vs bun",
      provenance: "agent",
      created: "2026-08-10T03:00:00Z",
    }),
    inboxOf("a", { title: "config change from web doc", created: "2026-08-10T01:00:00Z" }),
    inboxOf("b", {
      kind: "promotion",
      title: "promote node-tests",
      provenance: "agent",
      created: "2026-08-10T02:00:00Z",
      detail: "borderline",
    }),
  ];

  it("renders one ordered inbox: staged, promotions, contradictions by age", () => {
    const { model } = modelOver({ inbox });
    const rows = model.rows().filter((row) => row.kind === "inbox");
    expect(rows.map((row) => row.text)).toEqual([
      "░ staged · config change from web doc",
      "▓ promote · promote node-tests · borderline",
      "▓ conflict · pnpm vs bun",
    ]);
    expect(texts(model)).toContain("inbox ░3");
  });

  it("reaches the inbox by keyboard and approves or discards the cursored item", () => {
    const { model, recorded } = modelOver({ notes: garden.map(noteOf), inbox });
    press(model, "i");
    expect(model.cursorRow()?.inboxId).toBe("a");
    press(model, "a", "j", "d");
    expect(recorded.approved).toEqual(["a"]);
    expect(recorded.discarded).toEqual(["b"]);
  });

  it("a and d outside the inbox do nothing", () => {
    const { model, recorded } = modelOver({ notes: garden.map(noteOf), inbox });
    press(model, "g", "a", "d");
    expect(model.cursorRow()?.kind).toBe("note");
    expect(recorded.approved).toEqual([]);
    expect(recorded.discarded).toEqual([]);
  });

  it("stays navigable with hundreds of inbox items and windows the view", () => {
    const many = Array.from({ length: 400 }, (_, at) =>
      inboxOf(`item-${String(at).padStart(3, "0")}`, {
        created: `2026-08-10T00:${String(at % 60).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}Z`,
      }),
    );
    const { model } = modelOver({ inbox: many });
    press(model, "i");
    for (let step = 0; step < 500; step += 1) press(model, "j");
    const visible = model.visibleRows(6);
    expect(visible).toHaveLength(6);
    expect(visible.some(({ index }) => index === model.cursor)).toBe(true);
    expect(model.cursorRow()?.kind).toBe("inbox");
  });

  it("counts only staged items toward the staged count", () => {
    const { model } = modelOver({ inbox });
    expect(model.stagedCount()).toBe(1);
  });
});

describe("MemoryPaneModel focus and backlinks", () => {
  it("enter on a note focuses it with links out, a second hop, and links in", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    press(model, "g", "j", "enter");
    expect(model.focused()).toBe("split-ratios");
    expect(texts(model)).toEqual([
      "note · split-ratios",
      "█▓ split-ratios → ratio-resize-decision",
      "links out",
      "  ██ ratio-resize-decision",
      "  ▓█ layout-engine",
      "    ? missing-note",
      "links in",
      "  ██ ratio-resize-decision",
    ]);
  });

  it("second-hop links skip the focused note itself", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    press(model, "g", "enter");
    expect(model.focused()).toBe("ratio-resize-decision");
    const outRows = model.rows().filter((row) => row.id.startsWith("out:"));
    expect(outRows.map((row) => row.text.trim())).toEqual([
      "█▓ split-ratios → ratio-resize-decision",
      "▓█ layout-engine",
    ]);
  });

  it("resolves backlinks through aliases", () => {
    const notes = [
      noteOf({ name: "aliased-target", aliases: ["shorty"] }),
      noteOf({ name: "linker", links: ["shorty"] }),
    ];
    const { model } = modelOver({ notes });
    press(model, "g", "enter");
    expect(model.focused()).toBe("aliased-target");
    expect(texts(model)).toContain("links in");
    expect(texts(model).some((text) => text.includes("linker"))).toBe(true);
  });

  it("a focused note with no links shows a calm no-links line", () => {
    const { model } = modelOver({ notes: [noteOf({ name: "loner" })] });
    press(model, "g", "enter");
    expect(texts(model)).toEqual(["note · loner", "█▓ loner", "no links yet"]);
  });

  it("enter on a link row walks the graph one hop deeper", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    press(model, "g", "j", "enter", "j", "j", "enter");
    expect(model.focused()).toBe("layout-engine");
  });

  it("h returns to the overview with the cursor on the note it came from", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    press(model, "g", "j", "enter", "h");
    expect(model.focused()).toBeUndefined();
    expect(model.cursorRow()?.note).toBe("split-ratios");
  });

  it("dead links are dim and never focusable", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    press(model, "g", "pagedown", "enter");
    expect(model.focused()).toBe("layout-engine");
    const dead = model.rows().find((row) => row.text.includes("? missing-note"));
    expect(dead?.tone).toBe("dim");
    expect(dead?.selectable).toBe(false);
  });

  it("enter on a recall row focuses its note when it still exists", () => {
    const { model } = modelOver({
      notes: garden.map(noteOf),
      recalls: [
        { note: "vanished", scope: "workspace", provenance: "agent" },
        { note: "layout-engine", scope: "user", provenance: "user" },
      ],
    });
    const rows = model.rows();
    model.cursor = rows.findIndex((row) => row.kind === "recall");
    press(model, "enter");
    expect(model.focused()).toBeUndefined();
    model.cursor = rows.findIndex((row) => row.text.includes("layout-engine · user"));
    press(model, "enter");
    expect(model.focused()).toBe("layout-engine");
  });

  it("drops focus gracefully when the focused note vanishes on refresh", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    press(model, "g", "enter");
    model.setInputs({
      ...emptyMemoryInputs,
      scopes: ["workspace"],
      notes: [noteOf({ name: "solo" })],
    });
    expect(model.focused()).toBeUndefined();
    expect(model.cursorRow()?.selectable).toBe(true);
  });
});

describe("MemoryPaneModel navigation edges", () => {
  it("clamps at the top and bottom and skips headers", () => {
    const { model } = modelOver({ notes: garden.map(noteOf), inbox: [inboxOf("only")] });
    press(model, "k", "k");
    expect(model.cursorRow()?.selectable).toBe(true);
    const first = model.cursorRow()?.id;
    press(model, "k");
    expect(model.cursorRow()?.id).toBe(first);
    for (let step = 0; step < 50; step += 1) press(model, "j");
    const last = model.cursorRow()?.id;
    press(model, "j");
    expect(model.cursorRow()?.id).toBe(last);
    expect(
      model
        .rows()
        .filter((row) => row.selectable)
        .at(-1)?.id,
    ).toBe(last);
  });

  it("pageup and pagedown move by page across selectable rows only", () => {
    const { model } = modelOver({ notes: garden.map(noteOf), inbox: [inboxOf("x"), inboxOf("y")] });
    press(model, "pagedown");
    expect(model.cursorRow()?.selectable).toBe(true);
    press(model, "pageup");
    expect(model.cursorRow()?.id).toBe(model.rows().find((row) => row.selectable)?.id);
  });

  it("keeps the cursor on the same row across a refresh that grows the list", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    press(model, "g", "j");
    const anchored = model.cursorRow()?.id;
    model.setInputs({
      ...emptyMemoryInputs,
      scopes: ["workspace", "user"],
      notes: [noteOf({ name: "brand-new", curing: 0 }), ...garden.map(noteOf)],
      inbox: [inboxOf("fresh")],
    });
    expect(model.cursorRow()?.id).toBe(anchored);
  });

  it("r asks for a refresh", () => {
    const { model, recorded } = modelOver({ notes: garden.map(noteOf) });
    press(model, "r");
    expect(recorded.refreshes).toBe(1);
  });

  it("unhandled keys fall through", () => {
    const { model } = modelOver({ notes: garden.map(noteOf) });
    expect(model.handleKey(parseChord("z"), 5)).toBe(false);
    expect(model.handleKey(parseChord("q"), 5)).toBe(false);
  });

  it("ignores modified chords so shift+d and ctrl+a never touch the inbox", () => {
    const { model, recorded } = modelOver({ notes: garden.map(noteOf), inbox: [inboxOf("only")] });
    press(model, "i");
    expect(model.cursorRow()?.inboxId).toBe("only");
    expect(model.handleKey(parseChord("shift+d"), 5)).toBe(false);
    expect(model.handleKey(parseChord("ctrl+a"), 5)).toBe(false);
    expect(model.handleKey(parseChord("ctrl+r"), 5)).toBe(false);
    expect(recorded.discarded).toEqual([]);
    expect(recorded.approved).toEqual([]);
    expect(recorded.refreshes).toBe(0);
  });

  it("keeps the cursor on the same recall when a newer recall is appended", () => {
    const recallOf = (note: string): RecallEventView => ({
      note,
      scope: "workspace",
      provenance: "agent",
    });
    const recalls = Array.from({ length: 10 }, (_, at) => recallOf(`note-${at}`));
    const { model } = modelOver({ notes: garden.map(noteOf), recalls });
    const rows = model.rows();
    model.cursor = rows.findIndex((row) => row.kind === "recall" && row.note === "note-5");
    press(model, "j");
    expect(model.cursorRow()?.note).toBe("note-6");
    const anchored = model.cursorRow()?.id;
    model.setInputs({
      ...emptyMemoryInputs,
      scopes: ["workspace", "user"],
      notes: garden.map(noteOf),
      recalls: [...recalls, recallOf("note-10")],
    });
    expect(model.cursorRow()?.id).toBe(anchored);
    expect(model.cursorRow()?.note).toBe("note-6");
  });
});

describe("MemoryPaneModel property: cursor lands on a selectable visible row", () => {
  it("holds for any random op sequence over shifting inputs", () => {
    const big: MemoryPaneInputs = {
      scopes: ["workspace", "user"],
      notes: Array.from({ length: 60 }, (_, at) =>
        noteOf({
          name: `note-${at}`,
          curing: (at % 4) as CuringStage,
          provenance: (["user", "agent", "untrusted"] as const)[at % 3] as MemoryProvenance,
          links: at % 5 === 0 ? [`note-${(at + 1) % 60}`, "nowhere"] : [],
        }),
      ),
      inbox: Array.from({ length: 20 }, (_, at) => inboxOf(`stage-${at}`)),
      recalls: [{ note: "note-3", scope: "workspace", provenance: "agent" }],
      gardener: { state: "working", phasesDone: 1, phaseCount: 3 },
    };
    const small: MemoryPaneInputs = {
      ...emptyMemoryInputs,
      scopes: ["workspace"],
      notes: [noteOf({ name: "note-2", links: ["note-3"] }), noteOf({ name: "note-3" })],
    };
    let alternate = false;
    const model = new MemoryPaneModel(() => {}, {
      refresh: () => {
        alternate = !alternate;
        model.setInputs(alternate ? small : big);
      },
      approve: () => {},
      discard: () => {},
    });
    model.setInputs(big);
    const ops = ["j", "k", "h", "enter", "i", "g", "a", "d", "r", "pagedown", "pageup", "escape"];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let step = 0; step < 500; step += 1) {
      press(model, ops[Math.floor(random() * ops.length)] as string);
      const rows = model.rows();
      if (rows.length === 0 || !rows.some((row) => row.selectable)) continue;
      expect(model.cursor).toBeGreaterThanOrEqual(0);
      expect(model.cursor).toBeLessThan(rows.length);
      expect(rows[model.cursor]?.selectable).toBe(true);
      expect(model.visibleRows(5).some(({ index }) => index === model.cursor)).toBe(true);
    }
  });
});

describe("recallView", () => {
  it("passes the recall through and annotates citation and supersession", () => {
    expect(recallView({ note: "Ratio Rule", scope: "workspace", provenance: "agent" })).toEqual({
      note: "Ratio Rule",
      scope: "workspace",
      provenance: "agent",
    });
    expect(
      recallView({
        note: "Old Rule",
        scope: "workspace",
        provenance: "user",
        cited: true,
        supersededBy: "New Rule",
      }),
    ).toEqual({
      note: "Old Rule",
      scope: "workspace",
      provenance: "user",
      annotation: "cited · superseded by New Rule",
    });
  });

  it("renders an annotated recall in the pane", () => {
    const { model } = modelOver({
      notes: [noteOf({ name: "Ratio Rule" })],
      recalls: [
        recallView({ note: "Ratio Rule", scope: "workspace", provenance: "agent", cited: true }),
      ],
    });
    const recall = model.rows().find((row) => row.kind === "recall");
    expect(recall?.text).toContain("Ratio Rule");
    expect(recall?.text).toContain("cited");
  });
});

describe("gardenerSweepView", () => {
  it("summarizes only the phases that did work", () => {
    expect(gardenerSweepView({ promoted: 2, merged: 0, superseded: 1, flagged: 0 })).toEqual({
      state: "idle",
      detail: "2 promoted · 1 superseded",
    });
  });

  it("stays a calm idle tile after an uneventful sweep", () => {
    expect(gardenerSweepView({ promoted: 0, merged: 0, superseded: 0, flagged: 0 })).toEqual({
      state: "idle",
    });
  });
});
