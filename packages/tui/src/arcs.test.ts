import { describe, expect, it } from "vitest";
import {
  type ArcSummary,
  activeFirst,
  arcInk,
  arcOrdinalsOf,
  arcSlugProblem,
  arcTag,
  isArcSlug,
  suggestArcSlug,
} from "./arcs.ts";
import { arcAnchor } from "./chroma.ts";
import { keyworkNight } from "./theme.ts";

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

  it("keeps ordinals stable when a newer arc joins", () => {
    const before = arcOrdinalsOf(arcs);
    const after = arcOrdinalsOf([
      ...arcs,
      { slug: "newest", status: "active", created: "2026-08-22T00:00:00.000Z", sessions: 0 },
    ]);
    expect(after("middle")).toBe(before("middle"));
    expect(after("newest")).toBe(3);
  });

  it("inks an arc with its golden-angle anchor and unknown arcs with the dim text", () => {
    expect(arcInk(keyworkNight, 2)).toBe(arcAnchor(keyworkNight.ramp, 2));
    expect(arcInk(keyworkNight, undefined)).toBe(keyworkNight.textDim);
  });

  it("tags an arc with the slug grammar used on every surface", () => {
    expect(arcTag("dock-v2")).toBe("#dock-v2");
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
