import { describe, expect, it } from "vitest";
import type {
  InboxItemView,
  LedgerEventView,
  MemoryLayerView,
  MemoryNoteView,
  MemoryPaneInputs,
} from "./memory-pane-model.ts";
import {
  compactTokens,
  curingGlyph,
  curingWord,
  findNote,
  gardenRows,
  ledgerRows,
  noteRows,
  provenanceGlyph,
  queryRows,
} from "./memory-rows.ts";

const now = Date.parse("2026-08-22T12:00:00Z");
const workspace: MemoryLayerView = {
  id: "workspace",
  kind: "workspace",
  label: "workspace",
  prompt: { budget: 4096, used: 3900 },
};
const arc: MemoryLayerView = { id: "arc:dock-v2", kind: "arc", label: "dock-v2", arc: "dock-v2" };

function note(spec: Partial<MemoryNoteView> & { name: string }): MemoryNoteView {
  return {
    title: spec.name,
    layer: "workspace",
    provenance: "agent",
    curing: 3,
    links: [],
    aliases: [],
    created: "2026-08-20T12:00:00Z",
    ...spec,
  };
}

function inbox(spec: Partial<InboxItemView> & { id: string }): InboxItemView {
  return {
    kind: "staged",
    title: `item ${spec.id}`,
    provenance: "untrusted",
    created: "2026-08-22T10:00:00Z",
    ...spec,
  };
}

function inputsOf(partial: Partial<MemoryPaneInputs>): MemoryPaneInputs {
  return { layers: [workspace], notes: [], inbox: [], ledger: [], ...partial };
}

function texts(rows: readonly { text: string }[]): string[] {
  return rows.map((row) => row.text);
}

describe("memory glyphs and words", () => {
  it("maps the provenance ramp densest-first: user, agent, untrusted", () => {
    expect(provenanceGlyph("user")).toBe("█");
    expect(provenanceGlyph("agent")).toBe("▓");
    expect(provenanceGlyph("untrusted")).toBe("░");
  });

  it("walks the density ramp with the curing stage and names each rung", () => {
    expect([0, 1, 2, 3].map((stage) => curingGlyph(stage as 0 | 1 | 2 | 3))).toEqual([
      "░",
      "▒",
      "▓",
      "█",
    ]);
    expect([0, 1, 2, 3].map((stage) => curingWord(stage as 0 | 1 | 2 | 3))).toEqual([
      "fresh",
      "curing",
      "cured",
      "settled",
    ]);
  });

  it("compacts token counts the way the state line reads them", () => {
    expect(compactTokens(812)).toBe("812");
    expect(compactTokens(3900)).toBe("3.9k");
    expect(compactTokens(4096)).toBe("4.1k");
    expect(compactTokens(12000)).toBe("12k");
  });
});

describe("findNote", () => {
  it("resolves by name, title, or alias, preferring the asked-for layer", () => {
    const notes = [
      note({ name: "Dock Rule", aliases: ["dock"] }),
      note({ name: "Dock Rule", layer: "arc:dock-v2" }),
    ];
    expect(findNote(notes, "dock")?.layer).toBe("workspace");
    expect(findNote(notes, "DOCK RULE", "arc:dock-v2")?.layer).toBe("arc:dock-v2");
    expect(findNote(notes, "nothing")).toBeUndefined();
  });
});

describe("gardenRows", () => {
  it("leads with the state line and advertises the question box", () => {
    const rows = gardenRows(
      inputsOf({
        notes: [note({ name: "Dock Rule", injected: true }), note({ name: "Guess", curing: 0 })],
        inbox: [
          inbox({ id: "s1" }),
          inbox({ id: "c1", kind: "contradiction", provenance: "agent" }),
        ],
        gardener: { state: "idle", sweptAt: "2026-08-22T11:48:00Z" },
      }),
      { focusedArc: undefined, now },
    );
    expect(rows[0]?.text).toBe("2 notes · 1 curing · ░1 · 1 conflict · swept 12m · ? ask");
    expect(rows[0]?.selectable).toBe(false);
    expect(rows[0]?.spans?.map((span) => span.text)).toEqual([
      "2 notes",
      "1 curing",
      "░1",
      "1 conflict",
      "swept 12m",
      "? ask",
    ]);
  });

  it("splits a prompting layer into the notes in the prompt and the rest, superseded last", () => {
    const rows = gardenRows(
      inputsOf({
        notes: [
          note({ name: "Dock Rule", provenance: "user", injected: true, pinned: true }),
          note({ name: "Split Ratios", injected: true, recalls: 7 }),
          note({ name: "Old Rule", supersededBy: "Dock Rule", curing: 2 }),
          note({ name: "Fresh Guess", curing: 0 }),
          note({ name: "Useful", usefulness: 0.4, curing: 2 }),
        ],
      }),
      { focusedArc: undefined, now },
    );
    expect(texts(rows)).toEqual([
      "5 notes · 3 curing · ? ask",
      "workspace · 5 notes",
      "in prompt · 3.9k of 4.1k tokens",
      "██ Dock Rule · pinned · 2d",
      "█▓ Split Ratios · 2d · 7×",
      "by search only",
      "▓▓ Useful · 2d",
      "░▓ Fresh Guess · 2d",
      "▓▓ Old Rule → Dock Rule · 2d",
    ]);
    expect(rows.find((row) => row.text.startsWith("▓▓ Old Rule"))?.tone).toBe("dim");
  });

  it("puts the focused arc's layer first with its airlock cards, then the workspace", () => {
    const rows = gardenRows(
      inputsOf({
        layers: [workspace, arc],
        notes: [
          note({ name: "Dock Rule", injected: true }),
          note({ name: "Arc Lesson", layer: "arc:dock-v2" }),
        ],
        inbox: [
          inbox({
            id: "d1",
            kind: "proposal",
            provenance: "agent",
            title: "deliver Arc Lesson",
            arc: "dock-v2",
            detail: "eligible",
          }),
          inbox({ id: "s1", title: "Web Claim.md", detail: "note" }),
        ],
      }),
      { focusedArc: "dock-v2", now },
    );
    expect(texts(rows)).toEqual([
      "2 notes · ░1 · 1 proposal · ? ask",
      "#dock-v2 · 1 note · airlock ░1",
      "▓ proposal · deliver Arc Lesson · eligible · 2h",
      "█▓ Arc Lesson · 2d",
      "workspace · 1 note · inbox ░1",
      "░ staged · Web Claim.md · note · 2h",
      "in prompt · 3.9k of 4.1k tokens",
      "█▓ Dock Rule · 2d",
    ]);
    expect(rows[1]?.arc).toBe("dock-v2");
  });

  it("lists an unfocused empty arc nowhere and the focused empty arc as a calm header", () => {
    const quiet = gardenRows(
      inputsOf({ layers: [workspace, arc], notes: [note({ name: "Dock Rule", injected: true })] }),
      { focusedArc: undefined, now },
    );
    expect(texts(quiet)).not.toContain("#dock-v2 · no notes yet");
    const focused = gardenRows(
      inputsOf({ layers: [workspace, arc], notes: [note({ name: "Dock Rule", injected: true })] }),
      { focusedArc: "dock-v2", now },
    );
    expect(texts(focused)[1]).toBe("#dock-v2 · no notes yet");
  });

  it("stays calm over an empty vault", () => {
    expect(texts(gardenRows(inputsOf({}), { focusedArc: undefined, now }))).toEqual([
      "nothing remembered yet",
      "workspace",
    ]);
  });
});

describe("queryRows", () => {
  const inputs = inputsOf({
    layers: [workspace, arc],
    notes: [
      note({ name: "Dock Rule" }),
      note({ name: "Arc Lesson", layer: "arc:dock-v2" }),
      note({ name: "Old Rule", supersededBy: "Dock Rule" }),
    ],
  });

  it("shows the box with its hint before anything is typed", () => {
    expect(texts(queryRows(inputs, { text: "", pending: false }, now))).toEqual([
      "? ▌",
      "what do you know about … · enter opens a hit · esc closes",
    ]);
  });

  it("says it is asking until the outcome lands", () => {
    expect(texts(queryRows(inputs, { text: "dock", pending: true }, now))).toEqual([
      "? dock▌ · asking…",
      "░ asking…",
    ]);
  });

  it("renders every hit with a why-line: legs, ranks, arc boost, superseded floor", () => {
    const rows = queryRows(
      inputs,
      {
        text: "dock",
        pending: false,
        outcome: {
          source: "hybrid",
          embeddings: "voyage-3",
          hits: [
            {
              note: "Dock Rule",
              layer: "workspace",
              ranks: { lexical: 1, graph: 3 },
              superseded: false,
            },
            {
              note: "Arc Lesson",
              layer: "arc:dock-v2",
              ranks: { semantic: 2 },
              boost: 2,
              superseded: false,
            },
            { note: "Old Rule", layer: "workspace", ranks: { lexical: 2 }, superseded: true },
          ],
        },
      },
      now,
    );
    expect(texts(rows)).toEqual([
      "? dock▌ · hybrid · voyage-3",
      "█▓ Dock Rule · 2d",
      "   lexical #1 · graph #3",
      "█▓ Arc Lesson #dock-v2 · 2d",
      "   semantic #2 · #dock-v2 ×2",
      "█▓ Old Rule → Dock Rule · 2d",
      "   lexical #2 · superseded",
    ]);
    expect(rows.filter((row) => row.selectable).map((row) => row.note)).toEqual([
      "Dock Rule",
      "Arc Lesson",
      "Old Rule",
    ]);
  });

  it("discloses degradation and reads calm when nothing matches", () => {
    const rows = queryRows(
      inputs,
      {
        text: "zzz",
        pending: false,
        outcome: { source: "lexical-degraded", embeddings: "voyage-3", hits: [] },
      },
      now,
    );
    expect(texts(rows)).toEqual(["? zzz▌ · lexical · voyage-3 down", "░ nothing matches"]);
  });
});

describe("noteRows", () => {
  const notes = [
    note({
      name: "Dock Rule",
      provenance: "user",
      injected: true,
      pinned: true,
      recalls: 7,
      body: "# Dock Rule\n\nThe dock keeps 0.3 of the width.\n",
      links: ["Split Ratios"],
      supersedes: "Old Rule",
      relations: [
        { name: "Split Ratios", predicate: "relates_to", direction: "out" },
        { name: "Layout", predicate: "applies_to", direction: "in" },
      ],
    }),
    note({ name: "Split Ratios", links: ["Dock Rule", "Gone"] }),
    note({ name: "Old Rule", supersededBy: "Dock Rule" }),
    note({ name: "Layout" }),
  ];

  it("stacks title, fact strip, relations, the rendered body, and the walkable outline", () => {
    const [focus] = notes;
    if (focus === undefined) throw new Error("fixture");
    const rows = noteRows(
      inputsOf({ notes, inbox: [inbox({ id: "s1", title: "Dock Rule.md", note: "Dock Rule" })] }),
      focus,
      { now, bodyWidth: 40 },
    );
    expect(texts(rows)).toEqual([
      "██ Dock Rule",
      "user · settled · in prompt · pinned · 2d · recalled 7×",
      "supersedes Old Rule",
      "",
      "█ Dock Rule",
      "",
      "The dock keeps 0.3 of the width.",
      "",
      "links out",
      "  █▓ Split Ratios · 2d",
      "    ? Gone",
      "links in",
      "  █▓ Split Ratios · 2d",
      "← applies to",
      "  █▓ Layout · 2d",
      "staged",
      "░ staged · Dock Rule.md · 2h",
    ]);
    expect(rows.every((row) => row.rail === true)).toBe(true);
    const body = rows.filter((row) => row.kind === "body");
    expect(body.filter((row) => row.text !== "").every((row) => row.selectable)).toBe(true);
    expect(body.filter((row) => row.text === "").some((row) => row.selectable)).toBe(false);
    expect(rows.find((row) => row.kind === "inbox")?.inboxId).toBe("s1");
  });

  it("reads no links yet when the note stands alone", () => {
    const alone = note({ name: "Alone", body: "" });
    expect(texts(noteRows(inputsOf({ notes: [alone] }), alone, { now, bodyWidth: 40 }))).toEqual([
      "█▓ Alone",
      "agent · settled · by search only · 2d",
      "no links yet",
    ]);
  });

  it("folds mirrored typed relations into one navigable group", () => {
    const rule = note({
      name: "Dock Rule",
      body: "",
      supersedes: "Old Rule",
      relations: [
        { name: "Old Rule", predicate: "supersedes", direction: "out" },
        { name: "Old Rule", predicate: "superseded_by", direction: "in" },
        { name: "Layout", predicate: "depends_on", direction: "in" },
      ],
    });
    const rows = noteRows(
      inputsOf({ notes: [rule, note({ name: "Old Rule" }), note({ name: "Layout" })] }),
      rule,
      { now, bodyWidth: 40 },
    );
    expect(texts(rows).slice(3)).toEqual([
      "→ supersedes",
      "  █▓ Old Rule · 2d",
      "← depends on",
      "  █▓ Layout · 2d",
    ]);
  });

  it("wears the arc tag in the fact strip for arc-layer notes", () => {
    const lesson = note({
      name: "Arc Lesson",
      layer: "arc:dock-v2",
      distilledFrom: "arcs/dock-v2/MOC",
    });
    const rows = noteRows(inputsOf({ layers: [workspace, arc], notes: [lesson] }), lesson, {
      now,
      bodyWidth: 40,
    });
    expect(rows[1]?.text).toBe("agent · settled · 2d · #dock-v2");
    expect(rows[2]?.text).toBe("from #dock-v2");
  });
});

describe("ledgerRows", () => {
  const ledger: LedgerEventView[] = [
    {
      id: "op-1",
      at: "2026-08-22T11:00:00Z",
      verb: "edit",
      subject: "Dock Rule",
      notes: ["Dock Rule"],
    },
    {
      at: "2026-08-22T09:00:00Z",
      verb: "gardener sweep",
      subject: "promoted 1, merged 0",
      notes: [],
    },
    {
      id: "op-2",
      at: "2026-08-22T11:30:00Z",
      verb: "create",
      subject: "Fresh Guess",
      notes: ["Fresh Guess"],
    },
  ];

  it("feeds every event newest first with age, verb, and subject", () => {
    const rows = ledgerRows(inputsOf({ ledger }), { note: undefined, now });
    expect(texts(rows)).toEqual([
      "ledger · 3 events",
      "30m · create · Fresh Guess",
      "1h · edit · Dock Rule",
      "3h · gardener sweep · promoted 1, merged 0",
    ]);
    expect(rows[1]?.ledgerId).toBe("op-2");
    expect(rows[3]?.ledgerId).toBeUndefined();
  });

  it("filters to one note and names it", () => {
    const rows = ledgerRows(inputsOf({ ledger, notes: [note({ name: "Dock Rule" })] }), {
      note: "Dock Rule",
      now,
    });
    expect(texts(rows)).toEqual(["ledger · 1 event · Dock Rule", "1h · edit · Dock Rule"]);
  });

  it("stays calm when nothing has happened", () => {
    expect(texts(ledgerRows(inputsOf({}), { note: undefined, now }))).toEqual([
      "ledger · 0 events",
      "nothing recorded yet",
    ]);
  });
});
