import { describe, expect, it } from "vitest";
import { completeTheme } from "./complete-theme.ts";
import { gallery, themeNamed } from "./gallery.ts";
import type { Theme } from "./theme.ts";
import { auditTheme } from "./theme-audit.ts";

const headroomBothSurfacesRecord: readonly [string, number, number][] = [
  ["keywork-night", 3.1, 1.7],
  ["keywork-day", 13.1, 16.5],
  ["whiplash", 4.8, 6.9],
  ["whiplash-flash", 14.6, 17.1],
];

describe("auditTheme", () => {
  it.each(gallery.map((theme) => [theme.name, theme] as const))(
    "%s clears every floor at its native polarity",
    (_, theme) => {
      const audit = auditTheme(theme);
      expect(audit.failures).toEqual([]);
      expect(audit.minMarginLc).toBeGreaterThanOrEqual(0);
      expect(audit.sectionMarginLc).toBeGreaterThanOrEqual(0);
    },
  );

  it.each(headroomBothSurfacesRecord)(
    "%s has the headroom keywork-app ratchets: tokens %s, sections %s",
    (name, tokens, sections) => {
      const audit = auditTheme(galleryTheme(name));
      expect(audit.minMarginLc).toBe(tokens);
      expect(audit.sectionMarginLc).toBe(sections);
    },
  );

  it("names a tinted dark theme declared light on every pair that reads the wrong way", () => {
    const tinted = {
      ...galleryTheme("keywork-night"),
      name: "tinted",
      appearance: "light" as const,
    };
    const audit = auditTheme(tinted);
    expect(audit.theme).toBe("tinted");
    expect(audit.failures).toContain("text on background reads light-on-dark in a light theme");
    expect(audit.failures.length).toBeGreaterThan(20);
  });

  it("floors the margins to tenths and leaves a bare theme's section margin unbounded", () => {
    const night = galleryTheme("keywork-night");
    const { terminal, syntax, diff, selection, cursor, ...bare } = night;
    expect(auditTheme(bare).sectionMarginLc).toBe(Number.POSITIVE_INFINITY);
    expect(auditTheme(completeTheme(bare)).sectionMarginLc).toBeGreaterThanOrEqual(0);
    expect(auditTheme(bare).minMarginLc).toBe(3.1);
  });
});

function galleryTheme(name: string): Theme {
  const theme = themeNamed(name);
  if (theme === undefined) throw new Error(`no gallery theme ${name}`);
  return theme;
}
