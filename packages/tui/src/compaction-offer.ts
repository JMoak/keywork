import type { ContextReading } from "@keywork/engine";

export const compactionOfferNotice =
  "context nearly full · /compact [focus] folds older turns into a summary with a focus you pick · left alone, keywork compacts at the line";

export function compactionOfferDue(reading: ContextReading): boolean {
  return reading.used > reading.flushAt && reading.used <= reading.compactAt;
}

export class CompactionOffer {
  private offered = false;

  crossed(reading: ContextReading | undefined): boolean {
    if (reading === undefined) return false;
    if (reading.used <= reading.flushAt) {
      this.offered = false;
      return false;
    }
    if (this.offered || !compactionOfferDue(reading)) return false;
    this.offered = true;
    return true;
  }
}
