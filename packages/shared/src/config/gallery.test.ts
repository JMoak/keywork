import { describe, expect, it } from "vitest";
import { gallery, themeNamed, wardrobe } from "./gallery.ts";
import { contrastFailures, parseTheme } from "./theme.ts";

describe("the gallery", () => {
  it("clears every contrast floor in every theme, light and dark (T6)", () => {
    for (const theme of gallery) expect(contrastFailures(theme), theme.name).toEqual([]);
    expect(gallery.filter((theme) => theme.appearance === "light").length).toBeGreaterThan(1);
  });

  it("pairs symmetrically across opposite appearances", () => {
    for (const theme of gallery.filter((candidate) => candidate.pair !== undefined)) {
      const twin = themeNamed(theme.pair ?? "");
      expect(twin, `${theme.name} names ${theme.pair}`).toBeDefined();
      expect(twin?.pair, `${theme.pair} names ${theme.name} back`).toBe(theme.name);
      expect(twin?.appearance).not.toBe(theme.appearance);
    }
    expect(gallery.filter((theme) => theme.pair !== undefined)).toHaveLength(18);
  });
});

describe("wardrobe", () => {
  it("lets a closet theme replace a gallery theme in place and appends new ones", () => {
    const night = themeNamed("keywork-night");
    if (night === undefined) throw new Error("keywork-night left the gallery");
    const tailored = parseTheme({ ...night, gap: 3 });
    const extra = parseTheme({ ...night, name: "my-night", pair: undefined });
    const hanging = wardrobe([tailored, extra]);
    expect(hanging[0]).toEqual(tailored);
    expect(hanging.at(-1)).toEqual(extra);
    expect(hanging).toHaveLength(gallery.length + 1);
  });
});
