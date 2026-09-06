import { describe, expect, it } from "vitest";
import { resolvePage, resolvePageThresholds } from "./page.ts";
import { isLabelZone, titleBar, titleSpans, titleText } from "./title-bar.ts";

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

  it("tags the arc after the name at broadsheet only, where the border hue already carries it", () => {
    const bound = { ...full, arc: "dock-v2" };
    expect(titleBar(bound, 132, true)).toBe(" █ auth-retry-fix #dock-v2 · $0.012 · plan ");
    expect(titleBar(bound, 84, true)).toBe(" █ auth-retry-fix · $0.012 ");
  });

  it("sheds the arc tag before the mode word under pressure", () => {
    const bound = {
      ...full,
      arc: "a-rather-long-arc-name-that-goes-on",
      name: "a-long-descriptive-session-title-about-retry-logic",
    };
    const title = titleBar(bound, 100, true);
    expect(title).not.toContain("#a-rather-long-arc-name");
    expect(title).toContain("plan");
    expect(title).toContain("$0.012");
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

  it("hands sibling titles to the fitter for distinctive-word keeps", () => {
    const fitted = titleBar(
      { name: "memory-pane-scroll-fix", siblings: ["memory-pane-render-fix"] },
      46,
      true,
    );
    expect(fitted).toContain("scroll");
  });
});

describe("the title-bar spans", () => {
  const full = {
    name: "auth-retry-fix",
    stamp: "█",
    telemetry: "$0.012",
    modeWord: "plan",
    arc: "dock-v2",
  };

  it("tags every zone so the chrome can ink each on its own", () => {
    expect(titleSpans(full, 132, true).map((span) => [span.zone, span.text])).toEqual([
      ["stamp", "█"],
      ["joint", " "],
      ["slug", "auth-retry-fix"],
      ["joint", " "],
      ["arc", "#dock-v2"],
      ["joint", " · "],
      ["telemetry", "$0.012"],
      ["joint", " · "],
      ["mode", "plan"],
    ]);
  });

  it("is the one path the string title bar renders through", () => {
    for (const width of [8, 20, 44, 84, 132]) {
      for (const focused of [true, false]) {
        expect(titleBar(full, width, focused)).toBe(
          ` ${titleText(titleSpans(full, width, focused))} `,
        );
      }
    }
  });

  it("ends the label at the last stamp or slug span", () => {
    const spans = titleSpans(full, 132, true);
    const label = spans.slice(0, spans.findLastIndex((span) => isLabelZone(span.zone)) + 1);
    expect(titleText(label)).toBe("█ auth-retry-fix");
  });
});

describe("the title-bar bot zone", () => {
  const reviewer = { sigil: "⚖", name: "reviewer" };
  const bound = {
    name: "auth-retry-fix",
    stamp: "█",
    telemetry: "$0.012",
    modeWord: "plan",
    bot: reviewer,
  };

  it("leads the detail zone with sigil and name at broadsheet, after the arc tag when bound", () => {
    expect(titleBar(bound, 132, true)).toBe(" █ auth-retry-fix · ⚖ reviewer · $0.012 · plan ");
    expect(titleBar({ ...bound, arc: "dock-v2" }, 132, true)).toBe(
      " █ auth-retry-fix #dock-v2 · ⚖ reviewer · $0.012 · plan ",
    );
  });

  it("keeps the bot at column width on focused and unfocused panes alike", () => {
    expect(titleBar(bound, 84, true)).toBe(" █ auth-retry-fix · ⚖ reviewer · $0.012 ");
    expect(titleBar(bound, 84, false)).toBe(" █ auth-retry-fix · ⚖ reviewer ");
  });

  it("shrinks to the sigil alone at clipping and masthead widths", () => {
    expect(titleBar(bound, 56, true)).toBe(" █ auth-retry-fix · ⚖ ");
    expect(titleBar(bound, 30, true)).toBe(" █ auth-retry-fix · ⚖ ");
  });

  it("sheds the bot name before the arc tag under pressure, keeping the sigil", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    const pressed = {
      ...bound,
      arc: "dock-v2",
      name: [...words, "india", "juliet", "kilo"].join("-"),
    };
    const title = titleBar(pressed, 108, true);
    expect(title).toContain("#dock-v2");
    expect(title).toContain("· ⚖ ·");
    expect(title).toContain("plan");
    expect(title).not.toContain("reviewer");
  });

  it("outlives telemetry and the mode word, and yields only when the name has no room left", () => {
    const wide = { ...bound, name: "a-very-long-descriptive-session-title" };
    const tight = titleBar(wide, 48, true);
    expect(tight).not.toContain("plan");
    expect(tight).not.toContain("$0.012");
    expect(tight).toContain("⚖");
    expect(titleBar(wide, 24, true)).toBe(" █ session-title · ⚖ ");
    const tightest = titleBar(wide, 10, true);
    expect(tightest).not.toContain("⚖");
    expect(tightest.startsWith(" █ ")).toBe(true);
  });

  it("reads in monochrome because identity is text, at every tier", () => {
    for (const width of [24, 44, 84, 132]) {
      const title = titleBar({ name: "session-1", bot: reviewer }, width, true);
      expect(title).toContain("⚖");
      expect(Array.from(title).length).toBeLessThanOrEqual(width - 2);
    }
  });

  it("tags the bot span so the chrome can ink it apart from the label", () => {
    const spans = titleSpans({ name: "session-1", bot: reviewer }, 84, true);
    expect(spans.map((span) => [span.zone, span.text])).toEqual([
      ["slug", "session-1"],
      ["joint", " · "],
      ["bot", "⚖ reviewer"],
    ]);
    expect(spans.some((span) => span.zone === "bot" && isLabelZone(span.zone))).toBe(false);
  });
});
