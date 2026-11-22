import { describe, expect, it } from "vitest";
import {
  type ArcSummary,
  activeFirst,
  arcOrdinalsOf,
  arcSlugProblem,
  describeCloseOutcome,
  describeFinishOutcome,
  isArcSlug,
  suggestArcSlug,
} from "./arcs.ts";

const arcs: ArcSummary[] = [
  { slug: "later", status: "active", created: "2026-08-21T09:00:00.000Z", sessions: 0 },
  { slug: "first", status: "archived", created: "2026-08-01T09:00:00.000Z", sessions: 0 },
  { slug: "middle", status: "active", created: "2026-08-10T09:00:00.000Z", sessions: 0 },
];

describe("arc ordinals and ink", () => {
  it("numbers arcs by creation so a hue never moves once claimed", () => {
    const ordinalOf = arcOrdinalsOf(arcs);
    expect([ordinalOf("first"), ordinalOf("middle"), ordinalOf("later")]).toEqual([0, 1, 2]);
    expect(ordinalOf("unknown")).toBeUndefined();
  });
});

describe("arc slugs", () => {
  it("accepts the registry's grammar and explains a rejection", () => {
    expect(isArcSlug("dock-v2")).toBe(true);
    expect(isArcSlug("Dock V2")).toBe(false);
    expect(arcSlugProblem("Dock V2")).toContain("lowercase letters, digits, and inner hyphens");
    expect(arcSlugProblem("dock-v2")).toBeUndefined();
  });

  it("suggests a slug from the session title, skipping taken names", () => {
    expect(suggestArcSlug("Fix the dock layout", [])).toBe("fix-the-dock-layout");
    expect(suggestArcSlug("Fix the dock layout", ["fix-the-dock-layout"])).toBe("arc-2");
    expect(suggestArcSlug(undefined, [])).toBe("arc-1");
    expect(suggestArcSlug(undefined, ["arc-1", "arc-2"])).toBe("arc-3");
  });
});

describe("activeFirst", () => {
  it("puts active arcs newest first and archived arcs after them", () => {
    expect(activeFirst(arcs).map((arc) => arc.slug)).toEqual(["later", "middle", "first"]);
  });
});

describe("describeCloseOutcome", () => {
  it("appends the closing agent notice when the sweep degraded", () => {
    expect(
      describeCloseOutcome("dock", {
        kind: "closed",
        delivered: 0,
        released: 0,
        notice: "closing agent didn't run (boom) · swept without it",
      }),
    ).toBe(
      "arc dock closed · delivered 0 notes · closing agent didn't run (boom) · swept without it",
    );
  });
});

describe("describeFinishOutcome", () => {
  it("passes closed and pending through and explains undecided items and wedged sessions", () => {
    expect(describeFinishOutcome("dock", { kind: "closed", delivered: 2, released: 1 })).toBe(
      "arc dock closed · delivered 2 notes · 1 session released",
    );
    expect(
      describeFinishOutcome("dock", { kind: "undecided", items: ["Tie order", "Dock Rule"] }),
    ).toBe("arc dock still has 2 items to decide · a d c on each row");
    expect(describeFinishOutcome("dock", { kind: "wedged", sessions: ["s2"] })).toBe(
      "1 session didn't flush · f forces the close past them",
    );
  });
});
