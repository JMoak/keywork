import { describe, expect, it } from "vitest";
import { themeNamed } from "./gallery.ts";
import type { Theme } from "./theme.ts";
import { auditTheme } from "./theme-audit.ts";

const headroomBothSurfacesRecord: readonly [string, number, number][] = [
  ["keywork-night", 3.1, 1.7],
  ["keywork-day", 13.1, 16.5],
  ["whiplash", 4.8, 6.9],
  ["whiplash-flash", 14.6, 17.1],
];

describe("auditTheme", () => {
  it.each(headroomBothSurfacesRecord)(
    "%s has the headroom keywork-app ratchets: tokens %s, sections %s",
    (name, tokens, sections) => {
      const audit = auditTheme(galleryTheme(name));
      expect(audit.minMarginLc).toBe(tokens);
      expect(audit.sectionMarginLc).toBe(sections);
    },
  );
});

function galleryTheme(name: string): Theme {
  const theme = themeNamed(name);
  if (theme === undefined) throw new Error(`no gallery theme ${name}`);
  return theme;
}
