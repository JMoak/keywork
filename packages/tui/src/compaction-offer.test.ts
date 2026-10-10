import type { ContextReading } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { CompactionOffer, compactionOfferDue, compactionOfferNotice } from "./compaction-offer.ts";

function reading(used: number): ContextReading {
  return { used, window: 1000, flushAt: 800, compactAt: 900, declared: true };
}

describe("compactionOfferDue", () => {
  it("is due only between the flush line and the compaction line", () => {
    expect(compactionOfferDue(reading(800))).toBe(false);
    expect(compactionOfferDue(reading(801))).toBe(true);
    expect(compactionOfferDue(reading(900))).toBe(true);
    expect(compactionOfferDue(reading(901))).toBe(false);
  });
});

describe("CompactionOffer", () => {
  it("fires once per crossing and re-arms only after the reading falls back", () => {
    const offer = new CompactionOffer();
    expect(offer.crossed(reading(500))).toBe(false);
    expect(offer.crossed(reading(850))).toBe(true);
    expect(offer.crossed(reading(860))).toBe(false);
    expect(offer.crossed(reading(895))).toBe(false);
    expect(offer.crossed(reading(950))).toBe(false);
    expect(offer.crossed(reading(300))).toBe(false);
    expect(offer.crossed(reading(850))).toBe(true);
  });

  it("stays quiet without a reading or past the line keywork compacts at", () => {
    const offer = new CompactionOffer();
    expect(offer.crossed(undefined)).toBe(false);
    expect(offer.crossed(reading(950))).toBe(false);
    expect(offer.crossed(reading(850))).toBe(true);
  });

  it("names the command and the focus in the offer", () => {
    expect(compactionOfferNotice).toContain("/compact [focus]");
  });
});
