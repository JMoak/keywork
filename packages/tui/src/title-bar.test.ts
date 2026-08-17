import { describe, expect, it } from "vitest";
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

  it("drops the mode word at column width", () => {
    expect(titleBar(full, 84, true)).toBe(" █ auth-retry-fix · $0.012 ");
  });

  it("hides telemetry on unfocused panes below broadsheet", () => {
    expect(titleBar(full, 84, false)).toBe(" █ auth-retry-fix ");
    expect(titleBar(full, 132, false)).toContain("$0.012");
  });

  it("keeps only stamp and fitted name at clipping width", () => {
    const title = titleBar(full, 56, true);
    expect(title).toBe(" █ auth-retry-fix ");
  });

  it("renders a calm pane with zero marks", () => {
    expect(titleBar({ name: "session-1" }, 132, true)).toBe(" session-1 ");
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

  it("hands sibling titles to the fitter for distinctive-word keeps", () => {
    const fitted = titleBar(
      { name: "memory-pane-scroll-fix", siblings: ["memory-pane-render-fix"] },
      46,
      true,
    );
    expect(fitted).toContain("scroll");
  });
});
