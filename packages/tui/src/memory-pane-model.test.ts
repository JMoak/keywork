import { describe, expect, it } from "vitest";
import type { AirlockDigestView } from "./arcs.ts";
import { parseChord } from "./keys.ts";
import {
  emptyMemoryInputs,
  type InboxItemView,
  type MemoryLayerView,
  type MemoryNoteView,
  type MemoryPaneInputs,
  MemoryPaneModel,
  type MemoryQueryOutcome,
} from "./memory-pane-model.ts";

const now = Date.parse("2026-08-22T12:00:00Z");
const workspace: MemoryLayerView = {
  id: "workspace",
  kind: "workspace",
  label: "workspace",
  prompt: { budget: 4096, used: 900 },
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
    injected: true,
    file: `/vault/${spec.name}.md`,
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

interface Recorded {
  refreshes: number;
  approved: string[];
  discarded: string[];
  reverted: string[];
  opened: string[];
  asked: string[];
  notices: string[];
}

function modelOver(
  inputs: Partial<MemoryPaneInputs>,
  seams: { focusedArc?: string; notify?: () => void } = {},
) {
  const recorded: Recorded = {
    refreshes: 0,
    approved: [],
    discarded: [],
    reverted: [],
    opened: [],
    asked: [],
    notices: [],
  };
  const model = new MemoryPaneModel(
    seams.notify ?? (() => {}),
    {
      refresh: () => {
        recorded.refreshes += 1;
      },
      approve: (id) => recorded.approved.push(id),
      discard: (id) => recorded.discarded.push(id),
      revert: (id) => recorded.reverted.push(id),
      openFile: (path) => recorded.opened.push(path),
      ask: (query) => recorded.asked.push(query),
      notice: (text) => recorded.notices.push(text),
    },
    { focusedArc: () => seams.focusedArc, now: () => now },
  );
  model.setInputs({ ...emptyMemoryInputs, layers: [workspace], ...inputs });
  return { model, recorded };
}

function press(model: MemoryPaneModel, ...specs: string[]): void {
  for (const spec of specs) model.handleKey(parseChord(spec), 5);
}

function type(model: MemoryPaneModel, text: string): void {
  for (const character of text) {
    model.handleKey(parseChord(character), 5, character);
  }
}

function texts(model: MemoryPaneModel): string[] {
  return model.rows().map((row) => row.text);
}

const garden: MemoryNoteView[] = [
  note({ name: "Dock Rule", provenance: "user", links: ["Split Ratios"], supersedes: "Old Rule" }),
  note({ name: "Split Ratios", links: ["Dock Rule"], body: "60/40 by default.\n" }),
  note({ name: "Old Rule", supersededBy: "Dock Rule", injected: false }),
  note({ name: "Arc Lesson", layer: "arc:dock-v2", links: ["Dock Rule"] }),
];

describe("MemoryPaneModel garden lens", () => {
  it("opens on the garden with the cursor on the first note", () => {
    const { model } = modelOver({ notes: garden, layers: [workspace, arc] });
    expect(model.currentLens()).toBe("garden");
    expect(model.cursorRow()?.note).toBe("Dock Rule");
  });

  it("enter drills into the note lens and escape returns to the same row", () => {
    const { model } = modelOver({ notes: garden });
    press(model, "j", "enter");
    expect(model.currentLens()).toBe("note");
    expect(model.focused()).toBe("Split Ratios");
    expect(texts(model)[0]).toBe("█▓ Split Ratios");
    press(model, "escape");
    expect(model.currentLens()).toBe("garden");
    expect(model.cursorRow()?.note).toBe("Split Ratios");
  });

  it("i jumps to the inbox, a approves, d discards, and they do nothing elsewhere", () => {
    const { model, recorded } = modelOver({
      notes: garden,
      inbox: [inbox({ id: "s1" }), inbox({ id: "s2" })],
    });
    press(model, "g", "a", "d");
    expect(recorded.approved).toEqual([]);
    press(model, "i", "a", "j", "d");
    expect(recorded.approved).toEqual(["s1"]);
    expect(recorded.discarded).toEqual(["s2"]);
  });

  it("o opens the cursored note's file and u reverts its newest write from this run", () => {
    const { model, recorded } = modelOver({
      notes: garden,
      ledger: [
        {
          id: "old",
          at: "2026-08-22T09:00:00Z",
          verb: "create",
          subject: "Dock Rule",
          notes: ["Dock Rule"],
        },
        {
          id: "new",
          at: "2026-08-22T11:00:00Z",
          verb: "edit",
          subject: "Dock Rule",
          notes: ["Dock Rule"],
        },
        { at: "2026-08-22T11:30:00Z", verb: "gardener sweep", subject: "promoted 0", notes: [] },
      ],
    });
    press(model, "o", "u");
    expect(recorded.opened).toEqual(["/vault/Dock Rule.md"]);
    expect(recorded.reverted).toEqual(["old"]);
  });

  it("u on a note without a write this run explains itself instead of touching the vault", () => {
    const { model, recorded } = modelOver({ notes: garden });
    press(model, "u");
    expect(recorded.reverted).toEqual([]);
    expect(recorded.notices).toEqual(["no change to revert for Dock Rule this run"]);
  });

  it("tab and l switch to the ledger lens and tab brings the garden back", () => {
    const { model } = modelOver({ notes: garden });
    press(model, "tab");
    expect(model.currentLens()).toBe("ledger");
    press(model, "tab");
    expect(model.currentLens()).toBe("garden");
    press(model, "l");
    expect(model.currentLens()).toBe("ledger");
    press(model, "escape");
    expect(model.currentLens()).toBe("garden");
  });

  it("r asks for a refresh and unknown keys fall through", () => {
    const { model, recorded } = modelOver({ notes: garden });
    press(model, "r");
    expect(recorded.refreshes).toBe(1);
    expect(model.handleKey(parseChord("z"), 5)).toBe(false);
    expect(model.handleKey(parseChord("shift+a"), 5)).toBe(false);
  });

  it("orders the focused arc's layer first", () => {
    const { model } = modelOver(
      { notes: garden, layers: [workspace, arc] },
      { focusedArc: "dock-v2" },
    );
    expect(texts(model)[1]).toBe("#dock-v2 · 1 note");
  });
});

describe("MemoryPaneModel question box", () => {
  it("? opens the box, typing asks per keystroke, escape closes and clears", () => {
    const { model, recorded } = modelOver({ notes: garden });
    press(model, "?");
    expect(model.asking()).toBe(true);
    expect(texts(model)[0]).toBe("? ▌");
    type(model, "do");
    expect(recorded.asked).toEqual(["d", "do"]);
    expect(texts(model)[0]).toBe("? do▌ · asking…");
    press(model, "backspace");
    expect(recorded.asked).toEqual(["d", "do", "d"]);
    press(model, "escape");
    expect(model.asking()).toBe(false);
    expect(texts(model)[0]).toContain("? ask");
  });

  it("ignores an outcome for a query that was retyped before it landed", () => {
    const { model } = modelOver({ notes: garden });
    press(model, "?");
    type(model, "dock");
    const stale: MemoryQueryOutcome = {
      source: "lexical",
      hits: [{ note: "Old Rule", layer: "workspace", ranks: { lexical: 1 }, superseded: true }],
    };
    model.setQueryOutcome("doc", stale);
    expect(texts(model)[1]).toBe("░ asking…");
    model.setQueryOutcome("dock", {
      source: "lexical",
      hits: [{ note: "Dock Rule", layer: "workspace", ranks: { lexical: 1 }, superseded: false }],
    });
    expect(texts(model)[1]).toBe("██ Dock Rule · 2d");
  });

  it("down moves through hits while letters keep typing, enter opens the hit, escape keeps the question", () => {
    const { model, recorded } = modelOver({ notes: garden, layers: [workspace, arc] });
    press(model, "?");
    type(model, "dock");
    model.setQueryOutcome("dock", {
      source: "lexical",
      hits: [
        { note: "Dock Rule", layer: "workspace", ranks: { lexical: 1 }, superseded: false },
        {
          note: "Arc Lesson",
          layer: "arc:dock-v2",
          ranks: { lexical: 2 },
          boost: 2,
          superseded: false,
        },
      ],
    });
    press(model, "down");
    type(model, "j");
    expect(recorded.asked.at(-1)).toBe("dockj");
    model.setQueryOutcome("dockj", {
      source: "lexical",
      hits: [
        { note: "Dock Rule", layer: "workspace", ranks: { lexical: 1 }, superseded: false },
        {
          note: "Arc Lesson",
          layer: "arc:dock-v2",
          ranks: { lexical: 2 },
          boost: 2,
          superseded: false,
        },
      ],
    });
    press(model, "down", "enter");
    expect(model.currentLens()).toBe("note");
    expect(model.focused()).toBe("Arc Lesson");
    press(model, "escape");
    expect(model.asking()).toBe(true);
    expect(model.state()).toEqual({ lens: "garden", query: "dockj" });
  });
});

describe("MemoryPaneModel note lens", () => {
  it("walks the outline: enter on a link hops, h returns, the body is cursorable but inert", () => {
    const { model } = modelOver({ notes: garden });
    press(model, "j", "enter");
    expect(texts(model)).toContain("60/40 by default.");
    press(model, "j");
    expect(model.cursorRow()?.kind).toBe("body");
    press(model, "enter");
    expect(model.focused()).toBe("Split Ratios");
    press(model, "j", "enter");
    expect(model.focused()).toBe("Dock Rule");
    press(model, "h");
    expect(model.currentLens()).toBe("garden");
  });

  it("l opens the ledger filtered to the note and escape comes back to the note", () => {
    const { model } = modelOver({
      notes: garden,
      ledger: [
        {
          id: "e1",
          at: "2026-08-22T11:00:00Z",
          verb: "edit",
          subject: "Dock Rule",
          notes: ["Dock Rule"],
        },
        {
          id: "e2",
          at: "2026-08-22T11:10:00Z",
          verb: "edit",
          subject: "Split Ratios",
          notes: ["Split Ratios"],
        },
      ],
    });
    press(model, "enter", "l");
    expect(model.currentLens()).toBe("ledger");
    expect(texts(model)).toEqual(["ledger · 1 event · Dock Rule", "1h · edit · Dock Rule"]);
    expect(model.state()).toEqual({ lens: "ledger", note: "Dock Rule" });
    press(model, "escape");
    expect(model.currentLens()).toBe("note");
    expect(model.focused()).toBe("Dock Rule");
  });

  it("a and d act on staged rows that target the note, o opens its file", () => {
    const { model, recorded } = modelOver({
      notes: garden,
      inbox: [inbox({ id: "s1", title: "Dock Rule.md", note: "Dock Rule" })],
    });
    press(model, "enter");
    const staged = model.rows().findIndex((row) => row.inboxId === "s1");
    expect(staged).toBeGreaterThan(0);
    press(model, "end", "a", "o");
    expect(recorded.approved).toEqual(["s1"]);
    expect(recorded.opened).toEqual(["/vault/Dock Rule.md"]);
  });

  it("falls back to the garden when the focused note vanishes on refresh", () => {
    const { model } = modelOver({ notes: garden });
    press(model, "enter");
    model.setInputs({ ...emptyMemoryInputs, layers: [workspace], notes: garden.slice(1) });
    expect(model.currentLens()).toBe("garden");
    expect(model.focused()).toBeUndefined();
  });
});

describe("MemoryPaneModel ledger lens", () => {
  const ledger = [
    {
      id: "e1",
      at: "2026-08-22T11:00:00Z",
      verb: "edit",
      subject: "Dock Rule",
      notes: ["Dock Rule"],
    },
    { at: "2026-08-22T11:30:00Z", verb: "gardener sweep", subject: "promoted 0", notes: [] },
  ];

  it("enter opens the event's note, u reverts the pointed-at write, audit rows explain they cannot", () => {
    const { model, recorded } = modelOver({ notes: garden, ledger });
    press(model, "g", "tab");
    expect(model.cursorRow()?.text).toBe("30m · gardener sweep · promoted 0");
    press(model, "u");
    expect(recorded.notices).toEqual(["only this run's writes can be reverted"]);
    press(model, "j", "u");
    expect(recorded.reverted).toEqual(["e1"]);
    press(model, "enter");
    expect(model.currentLens()).toBe("note");
    expect(model.focused()).toBe("Dock Rule");
  });
});

describe("MemoryPaneModel persistence", () => {
  it("snapshots and restores lens, note, and question", () => {
    const { model } = modelOver({ notes: garden });
    press(model, "j", "enter");
    expect(model.state()).toEqual({ lens: "note", note: "Split Ratios" });
    const { model: revived, recorded } = modelOver({ notes: garden });
    revived.restore({ lens: "note", note: "Split Ratios" });
    expect(revived.currentLens()).toBe("note");
    expect(revived.focused()).toBe("Split Ratios");
    revived.restore({ lens: "garden", query: "dock" });
    expect(revived.asking()).toBe(true);
    expect(recorded.asked).toEqual(["dock"]);
    revived.restore({ lens: "note", note: "Vanished" });
    expect(revived.currentLens()).toBe("garden");
  });
});

describe("MemoryPaneModel property: cursor lands on a selectable visible row", () => {
  it("holds for any random op sequence over shifting inputs", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const big: MemoryPaneInputs = {
      layers: [workspace, arc],
      notes: Array.from({ length: 30 }, (_, at) =>
        note({
          name: `note-${at}`,
          layer: at % 3 === 0 ? "arc:dock-v2" : "workspace",
          links: [`note-${(at + 1) % 30}`],
          injected: at % 2 === 0,
          ...(at % 7 === 0 && { supersededBy: `note-${(at + 2) % 30}` }),
        }),
      ),
      inbox: Array.from({ length: 5 }, (_, at) => inbox({ id: `s${at}` })),
      ledger: Array.from({ length: 12 }, (_, at) => ({
        id: `op-${at}`,
        at: `2026-08-22T${String(at).padStart(2, "0")}:00:00Z`,
        verb: "edit",
        subject: `note-${at}`,
        notes: [`note-${at}`],
      })),
    };
    const small: MemoryPaneInputs = { ...big, notes: big.notes.slice(0, 4), inbox: [] };
    const { model } = modelOver(big);
    const ops = [
      "j",
      "k",
      "pagedown",
      "pageup",
      "enter",
      "escape",
      "tab",
      "l",
      "i",
      "g",
      "h",
      "?",
      "end",
      "home",
    ];
    for (let step = 0; step < 600; step += 1) {
      const roll = random();
      if (roll < 0.08) model.setInputs(step % 2 === 0 ? small : big);
      else {
        const op = ops[Math.floor(random() * ops.length)] ?? "j";
        model.handleKey(parseChord(op), 5, op.length === 1 ? op : undefined);
      }
      const visible = model.visibleRows(5);
      const selected = visible.filter((row) => row.selected);
      expect(selected.length).toBeLessThanOrEqual(1);
      if (selected.length === 1) expect(selected[0]?.row.selectable).toBe(true);
      expect(model.cursor).toBeGreaterThanOrEqual(0);
      expect(model.cursor).toBeLessThan(Math.max(1, model.rows().length));
    }
  });
});

describe("MemoryPaneModel airlock digest", () => {
  const digest: AirlockDigestView = {
    arc: "dock-v2",
    candidates: [
      {
        note: "Arc Lesson",
        title: "Arc Lesson",
        provenance: "agent",
        eligible: true,
        shortfalls: [],
      },
      {
        note: "Uncited Hunch",
        title: "Uncited Hunch",
        provenance: "agent",
        eligible: false,
        shortfalls: ["uncited"],
      },
    ],
    questions: [{ title: "Tie order", provenance: "user", created: "2026-08-21T12:00:00Z" }],
  };

  function digestModel() {
    const triaged: string[] = [];
    const finished: string[] = [];
    const delivered: string[] = [];
    const { model, recorded } = modelOver(
      {
        layers: [workspace, arc],
        notes: garden,
        inbox: [inbox({ id: "c1", kind: "airlock", arc: "dock-v2", title: "deliver Arc Lesson" })],
        airlocks: [digest],
      },
      { focusedArc: "dock-v2" },
    );
    const effects = model as unknown as {
      effects: {
        triageCandidate?: (arc: string, note: string, choice: string) => void;
        triageQuestion?: (arc: string, title: string, choice: string) => void;
        deliverEligible?: (arc: string) => void;
        finishClose?: (arc: string, force: boolean) => void;
      };
    };
    effects.effects.triageCandidate = (a, note, choice) => triaged.push(`${a}:${note}:${choice}`);
    effects.effects.triageQuestion = (a, title, choice) => triaged.push(`${a}:${title}:${choice}`);
    effects.effects.deliverEligible = (a) => delivered.push(a);
    effects.effects.finishClose = (a, force) => finished.push(`${a}:${force}`);
    return { model, recorded, triaged, finished, delivered };
  }

  it("a and d decide the cursored candidate, never touching the inbox approve path", () => {
    const { model, recorded, triaged } = digestModel();
    expect(texts(model)[2]).toBe("▓ Arc Lesson · undecided");
    press(model, "a");
    press(model, "d");
    expect(triaged).toEqual(["dock-v2:Arc Lesson:deliver", "dock-v2:Arc Lesson:leave"]);
    expect(recorded.approved).toEqual([]);
    expect(recorded.discarded).toEqual([]);
  });

  it("a, c, and d take a question through resolve, carry, and drop", () => {
    const { model, triaged } = digestModel();
    press(model, "j", "a", "c", "d");
    expect(triaged).toEqual([
      "dock-v2:Tie order:resolve",
      "dock-v2:Tie order:carry",
      "dock-v2:Tie order:drop",
    ]);
  });

  it("space unfolds and refolds the below-bar notes", () => {
    const { model } = digestModel();
    press(model, "j", "j");
    expect(model.cursorRow()?.airlock?.kind).toBe("fold");
    press(model, "space");
    expect(texts(model)).toContain("  ▓ Uncited Hunch · uncited");
    press(model, "space");
    expect(texts(model)).not.toContain("  ▓ Uncited Hunch · uncited");
  });

  it("enter on the close row finishes, f forces, a delivers every eligible candidate", () => {
    const { model, finished, delivered } = digestModel();
    press(model, "j", "j", "j");
    expect(model.cursorRow()?.airlock?.kind).toBe("finish");
    press(model, "enter", "f", "a");
    expect(finished).toEqual(["dock-v2:false", "dock-v2:true"]);
    expect(delivered).toEqual(["dock-v2"]);
  });

  it("i lands on the digest, the inbox's fourth door, even when the cursor rests on a note", () => {
    const { model } = digestModel();
    press(model, "g");
    expect(model.cursorRow()?.kind).toBe("note");
    press(model, "i");
    expect(model.cursorRow()?.airlock).toEqual({
      arc: "dock-v2",
      kind: "candidate",
      key: "Arc Lesson",
    });
  });

  it("enter on a candidate opens its note so it can be read before deciding", () => {
    const { model } = digestModel();
    press(model, "enter");
    expect(model.currentLens()).toBe("note");
    expect(model.focused()).toBe("Arc Lesson");
  });
});
