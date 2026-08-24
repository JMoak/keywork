import { describe, expect, it } from "vitest";
import {
  assumedContextWindow,
  compactionDue,
  contextBudgetFor,
  contextFullness,
  flushDue,
  formatTokenCount,
  readContext,
  reserveCaps,
} from "./context-budget.ts";

describe("contextBudgetFor", () => {
  it("assumes the large window and caps the reserves when nothing is declared", () => {
    expect(contextBudgetFor(undefined)).toEqual({
      window: assumedContextWindow,
      declared: false,
      flushReserve: reserveCaps.flush,
      compactionReserve: reserveCaps.compaction,
      keepRecent: reserveCaps.keepRecent,
    });
  });

  it("scales every reserve down with a small declared window", () => {
    expect(contextBudgetFor(8_192)).toEqual({
      window: 8_192,
      declared: true,
      flushReserve: 1_024,
      compactionReserve: 682,
      keepRecent: 819,
    });
  });

  it("keeps the flush mark ahead of the compaction mark at every window", () => {
    for (const window of [1_000, 4_096, 32_000, 128_000, 1_000_000]) {
      const budget = contextBudgetFor(window);
      expect(budget.flushReserve).toBeGreaterThan(budget.compactionReserve);
      expect(budget.keepRecent).toBeGreaterThan(0);
    }
  });

  it("treats a zero or negative declaration as undeclared", () => {
    expect(contextBudgetFor(0).declared).toBe(false);
    expect(contextBudgetFor(-5).window).toBe(assumedContextWindow);
  });
});

describe("readContext", () => {
  const budget = contextBudgetFor(10_000);

  it("turns the reserves into absolute marks", () => {
    expect(readContext(2_500, budget)).toEqual({
      used: 2_500,
      window: 10_000,
      flushAt: 8_750,
      compactAt: 9_167,
      declared: true,
    });
  });

  it("answers the two trigger questions off the same reading", () => {
    expect(flushDue(readContext(8_750, budget))).toBe(false);
    expect(flushDue(readContext(8_751, budget))).toBe(true);
    expect(compactionDue(readContext(8_751, budget))).toBe(false);
    expect(compactionDue(readContext(9_168, budget))).toBe(true);
  });

  it("reports fullness against the compaction mark, clamped to one", () => {
    expect(contextFullness(readContext(0, budget))).toBe(0);
    expect(contextFullness(readContext(9_167, budget))).toBe(1);
    expect(contextFullness(readContext(12_000, budget))).toBe(1);
    expect(contextFullness(readContext(4_583.5, budget))).toBeCloseTo(0.5, 3);
  });

  it("never reads negative or fractional usage", () => {
    expect(readContext(-3, budget).used).toBe(0);
    expect(readContext(12.6, budget).used).toBe(13);
  });
});

describe("formatTokenCount", () => {
  it("keeps counts short at every magnitude", () => {
    expect(formatTokenCount(412)).toBe("412");
    expect(formatTokenCount(4_096)).toBe("4.1k");
    expect(formatTokenCount(8_000)).toBe("8k");
    expect(formatTokenCount(41_300)).toBe("41k");
    expect(formatTokenCount(200_000)).toBe("200k");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });
});
