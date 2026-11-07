import { describe, expect, it } from "vitest";
import { calibrationOf, keeperFitRows, modelOfRow } from "./calibration.ts";
import { formatKeeperReport } from "./format.ts";
import type { DecisionRecord } from "./ratchet.ts";
import { loadRatchet } from "./ratchet.ts";
import { readKeeperReport, readKeeperRows } from "./report.ts";
import {
  answerAll,
  promotableClass,
  promotableNode,
  scratchNode,
  scriptedDecider,
  yesWith,
} from "./testing.ts";

const ratchet = await loadRatchet();

const times = (count: number, command: string) =>
  Array.from({ length: count }, (_, index) => `${command} ${index}`);

describe("calibrationOf", () => {
  it("fits nothing before the first fifty labelled answers", async () => {
    const nodeState = await scratchNode();
    await answerAll({ nodeState, ratchet, draw: () => 1 }, times(10, "npm test"), "granted");
    const [entry] = (await readKeeperReport({ nodeState, ratchet })).calibration ?? [];
    expect(entry).toMatchObject({
      model: "keeper-rules",
      ruleClass: "bash npm test *",
      state: "fitting",
      labelled: 10,
      fitRows: 10,
      heldOutRows: 0,
      acts: 0,
      sampleSize: 149,
    });
    expect(entry?.bar).toBeUndefined();
  });

  it("fits the bar on the first fifty answers and judges only the calls after them", async () => {
    const nodeState = await promotableNode(ratchet);
    const [entry] = (await readKeeperReport({ nodeState, ratchet })).calibration ?? [];
    expect(entry).toMatchObject({
      model: "keeper-rules",
      ruleClass: promotableClass,
      state: "accepted",
      labelled: 200,
      fitRows: keeperFitRows,
      heldOutRows: 150,
      bar: 0.96,
      fitActs: keeperFitRows,
      acts: 149,
      errors: 0,
      agreement: 1,
    });
    expect(entry?.lowerBound).toBeGreaterThanOrEqual(0.98);
    expect(entry?.interval?.upper).toBe(1);
    expect(entry?.interval?.lower).toBeLessThan(entry?.lowerBound ?? 0);
  }, 120_000);

  it("rejects a planned sample with a denial in it, and the rejection stands", async () => {
    const rows = await readKeeperRows({ nodeState: await promotableNode(ratchet), ratchet });
    const denied = denyAt(rows, 120);
    const [entry] = calibrationOf(ratchet, promotableClass, denied);
    expect(entry).toMatchObject({ state: "rejected", acts: 149, errors: 1 });
    expect(entry?.lowerBound).toBeLessThan(0.98);
    const grown = [...denied, ...rows.slice(0, 50).map((row, index) => renamed(row, index))];
    expect(calibrationOf(ratchet, promotableClass, grown)[0]?.state).toBe("rejected");
  }, 120_000);

  it("finds no bar when the keeper denies too often at every confidence", async () => {
    const nodeState = await scratchNode();
    const options = { nodeState, ratchet, draw: () => 1 };
    for (let round = 0; round < 25; round += 1) {
      await answerAll(options, [`npm test a${round}`], "granted");
      await answerAll(options, [`npm test b${round}`], "denied");
    }
    const [entry] = (await readKeeperReport({ nodeState, ratchet })).calibration ?? [];
    expect(entry).toMatchObject({ state: "no-bar", labelled: 50, heldOutRows: 0 });
  });

  it("keeps a bar per model, so a pinned model that moves starts its own fit", async () => {
    const nodeState = await scratchNode();
    const decider = scriptedDecider(yesWith(0.9));
    await answerAll(
      { nodeState, ratchet, decider, draw: () => 1 },
      times(3, "npm test"),
      "granted",
    );
    const rows = await readKeeperRows({ nodeState, ratchet });
    const moved = rows.map((row, index) => (index === 0 ? { ...row, model: "nimble-0.9b" } : row));
    const entries = calibrationOf(ratchet, "bash npm test *", moved);
    expect(entries.map((entry) => [entry.model, entry.labelled])).toEqual([
      ["nimble-0.9b", 1],
      ["nimble-0.8b@2026-10-01", 2],
    ]);
    expect(modelOfRow(rows[0] as DecisionRecord)).toBe("nimble-0.8b@2026-10-01");
  });

  it("shows calibration per model and class in the printed report", async () => {
    const nodeState = await promotableNode(ratchet);
    const lines = formatKeeperReport(await readKeeperReport({ nodeState, ratchet })).split("\n");
    expect(lines).toContain(
      "model         rule class         labelled   bar  held-out  review  state",
    );
    expect(lines).toContain(
      "keeper-rules  bash make build *       200  0.96   149/149     0/0  accepted",
    );
    expect(lines.find((line) => line.startsWith("  keeper-rules, bash make build *:"))).toMatch(
      /accepted, 149 of 149 held-out calls above bar 0\.96 approved \(95% interval .* exact lower bound 98\.\d%$/,
    );
  }, 120_000);
});

function denyAt(rows: readonly DecisionRecord[], index: number): DecisionRecord[] {
  return rows.map((row, at) =>
    at === index && row.outcome !== undefined
      ? { ...row, outcome: { ...row.outcome, truth: false, correct: false } }
      : row,
  );
}

function renamed(row: DecisionRecord, index: number): DecisionRecord {
  return { ...row, id: `later-${index}`, stateHash: `later-${index}` };
}
