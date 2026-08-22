import { describe, expect, it } from "vitest";
import type { ArcSummary } from "./arcs.ts";
import { type ArcGroupRow, ArcsPaneModel, arcGroupLine } from "./arcs-pane-model.ts";
import { parseChord } from "./keys.ts";
import type { SessionOverviewItem, SessionPresence } from "./sessions-overview-model.ts";

interface Recorded {
  refreshes: number;
  activated: string[];
  created: string[];
  closed: string[];
  abandoned: string[];
  rejected: string[];
}

const minute = 60_000;
const now = 60 * minute;

const arcs: ArcSummary[] = [
  {
    slug: "dock-v2",
    status: "active",
    created: new Date(now - 50 * minute).toISOString(),
    sessions: 0,
  },
  {
    slug: "infra",
    status: "active",
    created: new Date(now - 40 * minute).toISOString(),
    sessions: 0,
  },
  {
    slug: "old-login",
    status: "archived",
    created: new Date(now - 3 * 24 * 60 * minute).toISOString(),
    sessions: 0,
  },
];

function itemOf(id: string, minutesAgo: number, extra: Partial<SessionOverviewItem> = {}) {
  return {
    id,
    title: `title-${id}`,
    modifiedAt: now - minutesAgo * minute,
    entryCount: 4,
    branchCount: 0,
    labelCount: 0,
    ...extra,
  };
}

const items: SessionOverviewItem[] = [
  itemOf("s1", 5, { arc: "dock-v2", costNanos: 1_000_000_000 }),
  itemOf("s2", 30, { arc: "dock-v2", costNanos: 500_000_000 }),
  itemOf("s3", 2, { arc: "infra" }),
  itemOf("s4", 9, {}),
  itemOf("s5", 100, { arc: "old-login", costNanos: 1_000_000 }),
];

function modelOver(
  seams: { presence?: SessionPresence; currentSession?: () => string | undefined } = {},
  inputs: { arcs?: ArcSummary[]; items?: SessionOverviewItem[] } = {},
) {
  const recorded: Recorded = {
    refreshes: 0,
    activated: [],
    created: [],
    closed: [],
    abandoned: [],
    rejected: [],
  };
  const model = new ArcsPaneModel(
    () => {},
    {
      refresh: () => {
        recorded.refreshes += 1;
      },
      activate: (id) => recorded.activated.push(id),
      create: (slug) => recorded.created.push(slug),
      close: (slug) => recorded.closed.push(slug),
      abandon: (slug) => recorded.abandoned.push(slug),
      reject: (reason) => recorded.rejected.push(reason),
    },
    { ...seams, now: () => now },
  );
  model.setInputs(inputs.arcs ?? arcs, inputs.items ?? items);
  return { model, recorded };
}

function press(model: ArcsPaneModel, ...specs: string[]): void {
  for (const spec of specs) model.handleKey(parseChord(spec), 5, typedSequence(spec));
}

function typedSequence(spec: string): string | undefined {
  if (spec === "space") return " ";
  return spec.length === 1 ? spec : undefined;
}

function lines(rows: ArcGroupRow[], cursor = -1): string[] {
  return rows.map((row, at) => arcGroupLine(row, at === cursor));
}

describe("ArcsPaneModel rows", () => {
  it("groups sessions by arc: active arcs first, the unbound group, then archived arcs dimmed last", () => {
    const { model } = modelOver();
    expect(lines(model.rows())).toEqual([
      "░ dock-v2 · 2 sessions · 5m",
      "░ infra · 1 session · 2m",
      "░ no arc · 1 session · 9m",
      "░ old-login · archived · 1 session · 1h",
    ]);
  });

  it("shows the summed known cost only on the cursored row and says when part is unpriced", () => {
    const { model } = modelOver();
    expect(lines(model.rows(), 0)[0]).toBe("░ dock-v2 · 2 sessions · 5m · $1.50");
    const { model: partial } = modelOver(
      {},
      { items: [...items, itemOf("s6", 1, { arc: "dock-v2" })] },
    );
    expect(lines(partial.rows(), 0)[0]).toBe("░ dock-v2 · 3 sessions · 1m · $1.50 + unpriced");
  });

  it("reads liveness off presence: busy beats attached beats idle across the members", () => {
    const presence: SessionPresence = {
      paneFor: (id) => (id === "s2" || id === "s3" ? `pane-${id}` : undefined),
      busy: (id) => id === "s2",
    };
    const { model } = modelOver({ presence });
    expect(lines(model.rows()).map((line) => line[0])).toEqual(["█", "▓", "░", "░"]);
  });

  it("marks the group holding the current session", () => {
    const { model } = modelOver({ currentSession: () => "s4" });
    expect(model.rows().map((row) => row.current)).toEqual([false, false, true, false]);
  });

  it("falls back to the arc's creation age when it has no sessions", () => {
    const { model } = modelOver({}, { items: [] });
    expect(lines(model.rows())).toEqual([
      "░ dock-v2 · no sessions · 50m",
      "░ infra · no sessions · 40m",
      "░ old-login · archived · no sessions · 3d",
    ]);
  });

  it("counts only active arcs", () => {
    const { model } = modelOver();
    expect(model.arcCount()).toBe(2);
    expect(model.activeSlugs()).toEqual(["dock-v2", "infra"]);
  });
});

describe("ArcsPaneModel keys", () => {
  it("moves with j/k, drills on enter, lists the member sessions, and returns on escape", () => {
    const { model } = modelOver();
    press(model, "j", "enter");
    expect(model.level()).toBe("sessions");
    expect(model.drilled()).toEqual({ kind: "arc", slug: "infra" });
    expect(model.sessions.rows().map((row) => row.id)).toEqual(["s3"]);
    press(model, "escape");
    expect(model.level()).toBe("arcs");
    expect(model.cursor).toBe(1);
  });

  it("activates a member session on enter at the sessions level", () => {
    const { model, recorded } = modelOver();
    press(model, "enter", "j", "enter");
    expect(recorded.activated).toEqual(["s2"]);
  });

  it("drills into the unbound group", () => {
    const { model } = modelOver();
    press(model, "j", "j", "l");
    expect(model.drilled()).toEqual({ kind: "unbound" });
    expect(model.sessions.rows().map((row) => row.id)).toEqual(["s4"]);
  });

  it("names a new arc inline and validates the slug before creating", () => {
    const { model, recorded } = modelOver();
    press(model, "n");
    expect(model.naming).toBe(true);
    for (const character of "checkout-flow") press(model, character);
    press(model, "enter");
    expect(recorded.created).toEqual(["checkout-flow"]);
    expect(model.naming).toBe(false);

    press(model, "n");
    for (const character of "Bad Name") press(model, character === " " ? "space" : character);
    press(model, "enter");
    expect(recorded.created).toEqual(["checkout-flow"]);
    expect(recorded.rejected[0]).toContain("isn't an arc slug");

    press(model, "n");
    for (const character of "infra") press(model, character);
    press(model, "enter");
    expect(recorded.rejected[1]).toContain("already exists");
  });

  it("spells the name draft from the raw sequence and drops control input", () => {
    const { model, recorded } = modelOver();
    press(model, "n");
    model.handleKey(parseChord("shift+a"), 5, "A");
    expect(model.handleKey(parseChord("ctrl+a"), 5, "")).toBe(false);
    press(model, "b", "enter");
    expect(recorded.created).toEqual([]);
    expect(recorded.rejected[0]).toContain('"Ab" isn\'t an arc slug');
  });

  it("escape abandons the name draft without creating", () => {
    const { model, recorded } = modelOver();
    press(model, "n", "x", "escape");
    expect(model.naming).toBe(false);
    expect(recorded.created).toEqual([]);
  });

  it("closes and abandons only active arcs under the cursor", () => {
    const { model, recorded } = modelOver();
    press(model, "c", "shift+a");
    expect(recorded.closed).toEqual(["dock-v2"]);
    expect(recorded.abandoned).toEqual(["dock-v2"]);
    press(model, "j", "j", "j", "c", "shift+a");
    expect(recorded.closed).toEqual(["dock-v2"]);
    expect(recorded.abandoned).toEqual(["dock-v2"]);
  });

  it("refreshes on r and keeps the cursor on the same arc across reloads", () => {
    const { model, recorded } = modelOver();
    press(model, "j", "r");
    expect(recorded.refreshes).toBe(1);
    model.setInputs(
      [
        { slug: "zeta", status: "active", created: new Date(now).toISOString(), sessions: 0 },
        ...arcs,
      ],
      items,
    );
    expect(model.cursorRow()?.label).toBe("infra");
  });

  it("restores a drilled arc from its seam", () => {
    const model = new ArcsPaneModel(
      () => {},
      {
        refresh: () => {},
        activate: () => {},
        create: () => {},
        close: () => {},
        abandon: () => {},
        reject: () => {},
      },
      { now: () => now, drilled: { kind: "arc", slug: "dock-v2" } },
    );
    model.setInputs(arcs, items);
    expect(model.level()).toBe("sessions");
    expect(model.sessions.rows().map((row) => row.id)).toEqual(["s1", "s2"]);
  });
});
