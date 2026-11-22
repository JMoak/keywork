import { describe, expect, it } from "vitest";
import { resolvePage, resolvePageThresholds } from "./page.ts";
import { titleBar } from "./title-bar.ts";

describe("the title-bar grammar", () => {
  const full = {
    name: "auth-retry-fix",
    stamp: "█",
    telemetry: "$0.012",
    modeWord: "plan",
  };

  it("renders every zone at broadsheet width", () => {
    expect(titleBar(full, 132, true)).toBe(" █ auth-retry-fix · $0.012 · plan ");
  });

  it("keeps only stamp and fitted name at clipping width", () => {
    const title = titleBar(full, 56, true);
    expect(title).toBe(" █ auth-retry-fix ");
  });

  it("sheds mode word then telemetry then name words under pressure", () => {
    const wide = { ...full, name: "a-very-long-descriptive-session-title" };
    const roomy = titleBar(wide, 132, true);
    expect(roomy).toContain("plan");
    const tight = titleBar(wide, 44, true);
    expect(tight).not.toContain("plan");
    expect(tight).not.toContain("$0.012");
    expect(tight.startsWith(" █ ")).toBe(true);
  });

  it("keeps the stamp as the last mark standing", () => {
    const title = titleBar(full, 12, true);
    expect(title.startsWith(" █ ")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(12);
  });

  it("never exceeds the pane width", () => {
    for (const width of [8, 20, 40, 70, 100, 140]) {
      for (const focused of [true, false]) {
        const title = titleBar(full, width, focused);
        expect(Array.from(title).length).toBeLessThanOrEqual(Math.max(width - 2, 6));
      }
    }
  });

  it("tiers by the configured page thresholds, so title and body agree at the boundary", () => {
    const thresholds = resolvePageThresholds({ broadsheetAt: 90, columnAt: 60, clippingAt: 30 });
    expect(resolvePage(92, thresholds).tier).toBe("broadsheet");
    expect(titleBar(full, 92, true, thresholds)).toBe(" █ auth-retry-fix · $0.012 · plan ");
    expect(titleBar(full, 92, true)).toBe(" █ auth-retry-fix · $0.012 ");
    expect(titleBar(full, 59, true, thresholds)).toBe(" █ auth-retry-fix ");
  });

  it("measures zones in display cells, not code points", () => {
    const wide = { name: "我们在这里写字", stamp: "█", telemetry: "$0.012" };
    const title = titleBar(wide, 16, true);
    expect(Array.from(title).length).toBeLessThanOrEqual(14);
    expect(title.trim().length).toBeGreaterThan(0);
  });
});
