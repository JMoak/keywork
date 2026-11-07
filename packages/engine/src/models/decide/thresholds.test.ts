import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyThresholdBook,
  readThresholdBook,
  type StoredThreshold,
  thresholdFor,
  withThreshold,
  writeThresholdBook,
} from "./thresholds.ts";

const jev: StoredThreshold = {
  provider: "openrouter",
  model: "typesafe/jev-1.14",
  version: "typesafe/jev-1.14",
  question: "keeper.would-approve",
  threshold: 0.86,
  precision: 0.97,
  support: 120,
  fittedAt: "2026-11-05T12:00:00Z",
};

describe("the threshold book", () => {
  const book = withThreshold(emptyThresholdBook, jev);

  it("finds a threshold only for the exact model, version and question it was fitted on", () => {
    expect(thresholdFor(book, jev)).toEqual(jev);
    expect(thresholdFor(book, { ...jev, version: "typesafe/jev-1.13" })).toBeUndefined();
    expect(thresholdFor(book, { ...jev, model: "typesafe/jev-1.13" })).toBeUndefined();
    expect(thresholdFor(book, { ...jev, provider: "typesafe" })).toBeUndefined();
    expect(thresholdFor(book, { ...jev, question: "memory.relevant" })).toBeUndefined();
  });

  it("replaces a refit for the same key instead of keeping both", () => {
    const refit = withThreshold(book, { ...jev, threshold: 0.9, fittedAt: "2026-11-06T12:00:00Z" });
    expect(refit.thresholds).toHaveLength(1);
    expect(thresholdFor(refit, jev)?.threshold).toBe(0.9);
  });

  describe("on disk", () => {
    let dir: string | undefined;
    afterEach(async () => {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    });

    it("round-trips through a JSON file and reads a missing file as empty", async () => {
      dir = await mkdtemp(join(tmpdir(), "keywork-thresholds-"));
      const path = join(dir, "thresholds.json");
      expect(await readThresholdBook(path)).toEqual(emptyThresholdBook);
      await writeThresholdBook(path, book);
      expect(await readThresholdBook(path)).toEqual(book);
      expect(await readFile(path, "utf8")).toMatch(/\n$/);
    });
  });
});
