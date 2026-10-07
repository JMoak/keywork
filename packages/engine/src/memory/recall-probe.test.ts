import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  compareAgainstMemoryOff,
  memoryOffControl,
  probeCorpusStub,
  runRecallProbe,
} from "./recall-probe.ts";
import { MemorySearch } from "./search.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-recall-probe-");

async function probeSearch(): Promise<MemorySearch> {
  const store = new MemoryStore({ vaultRoot: await scratch(), trusted: true });
  for (const note of probeCorpusStub.notes) await store.writeNote(note);
  return new MemorySearch(store);
}

describe("the recall probe", () => {
  it("passes its lexical-only floor on the single-hop corpus", async () => {
    const metrics = await runRecallProbe(await probeSearch(), probeCorpusStub.cases, {
      hops: "single",
    });
    expect(metrics.cases).toBe(3);
    expect(metrics.missed).toEqual([]);
    expect(metrics.recallAtK).toBe(1);
  });

  it("records the multi-hop baseline separately so the graph leg has a target", async () => {
    const metrics = await runRecallProbe(await probeSearch(), probeCorpusStub.cases, {
      hops: "multi",
    });
    expect(metrics.cases).toBe(1);
    expect(metrics.recallAtK).toBeGreaterThanOrEqual(0);
  });

  it("measures recall value against a memory-off control", async () => {
    const comparison = await compareAgainstMemoryOff(await probeSearch(), probeCorpusStub.cases, {
      hops: "single",
    });
    expect(comparison.control.recallAtK).toBe(0);
    expect(comparison.control.missed).toEqual(["install", "gate", "layout"]);
    expect(comparison.lift).toBe(1);
    expect((await memoryOffControl.search("anything")).hits).toEqual([]);
  });
});
