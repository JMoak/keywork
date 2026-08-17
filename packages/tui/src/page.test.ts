import { describe, expect, it } from "vitest";
import {
  broadsheetProseMeasure,
  columnPage,
  pageTierThresholds,
  proseWidth,
  resolvePage,
  resolvePageThresholds,
} from "./page.ts";

describe("resolvePage", () => {
  it("maps pane widths to the four tiers at the documented boundaries", () => {
    expect(resolvePage(160).tier).toBe("broadsheet");
    expect(resolvePage(100).tier).toBe("broadsheet");
    expect(resolvePage(99).tier).toBe("column");
    expect(resolvePage(70).tier).toBe("column");
    expect(resolvePage(69).tier).toBe("clipping");
    expect(resolvePage(40).tier).toBe("clipping");
    expect(resolvePage(39).tier).toBe("masthead");
    expect(resolvePage(1).tier).toBe("masthead");
  });

  it("derives every page property from the tier", () => {
    expect(resolvePage(120)).toEqual({
      tier: "broadsheet",
      proseGutter: 1,
      proseMeasure: broadsheetProseMeasure,
      toneDepth: 4,
      masthead: false,
    });
    expect(resolvePage(80)).toEqual(columnPage);
    expect(resolvePage(50)).toMatchObject({
      tier: "clipping",
      proseGutter: 0,
      proseMeasure: undefined,
      toneDepth: 3,
      masthead: false,
    });
    expect(resolvePage(20)).toMatchObject({ tier: "masthead", masthead: true });
  });

  it("honors overridden thresholds", () => {
    const custom = resolvePageThresholds({ broadsheetAt: 80 });
    expect(resolvePage(90, custom).tier).toBe("broadsheet");
    expect(resolvePage(79, custom).tier).toBe("column");
  });
});

describe("resolvePageThresholds", () => {
  it("returns the named defaults when nothing is overridden", () => {
    expect(resolvePageThresholds()).toEqual(pageTierThresholds);
    expect(pageTierThresholds).toEqual({ broadsheetAt: 100, columnAt: 70, clippingAt: 40 });
  });

  it("rejects thresholds that do not rise clipping < column < broadsheet", () => {
    expect(() => resolvePageThresholds({ columnAt: 120 })).toThrow(/must rise/);
    expect(() => resolvePageThresholds({ clippingAt: 70 })).toThrow(/must rise/);
  });

  it("rejects fractional and non-positive column counts", () => {
    expect(() => resolvePageThresholds({ broadsheetAt: 100.5 })).toThrow(/whole column count/);
    expect(() => resolvePageThresholds({ clippingAt: 0 })).toThrow(/whole column count/);
  });
});

describe("proseWidth", () => {
  it("caps broadsheet prose at the measure inside the gutters", () => {
    const broadsheet = resolvePage(120);
    expect(proseWidth(broadsheet, 116)).toBe(broadsheetProseMeasure);
    expect(proseWidth(broadsheet, 60)).toBe(58);
  });

  it("gives column and clipping prose the full bleed", () => {
    expect(proseWidth(columnPage, 76)).toBe(76);
    expect(proseWidth(resolvePage(50), 46)).toBe(46);
  });

  it("never collapses below one column", () => {
    expect(proseWidth(resolvePage(120), 0)).toBe(1);
  });
});
