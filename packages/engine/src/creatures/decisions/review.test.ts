import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { keeperLedgerPath, keeperReviewPath } from "./files.ts";
import { loadRatchet } from "./ratchet.ts";
import { recordKeeperVerdict } from "./record.ts";
import { readKeeperReport } from "./report.ts";
import {
  answerBlindReview,
  blindReviewOf,
  blindReviewSource,
  keeperAuditRate,
  pendingReviews,
  readReviewBook,
} from "./review.ts";
import { answeredAsk, bashAsk, denied, granted, ledgerRows, scratchNode } from "./testing.ts";

const ratchet = await loadRatchet();
const now = () => new Date("2026-11-06T11:00:00.000Z");

function drawsFrom(values: readonly number[]): () => number {
  let next = 0;
  return () => values[next++ % values.length] ?? 1;
}

describe("the blind review draw", () => {
  it("samples answered asks at ratchet's audit rate of five percent", async () => {
    expect(keeperAuditRate).toBe(0.05);
    const nodeState = await scratchNode();
    const draw = drawsFrom([0.01, 0.5, 0.049, 0.05]);
    const outcomes = [];
    for (const command of ["npm test", "npm test -s", "npm test --ci", "npm test -w"]) {
      const ask = bashAsk(command);
      outcomes.push(
        await recordKeeperVerdict(answeredAsk(ask, granted(ask)), { nodeState, ratchet, draw }),
      );
    }
    expect(outcomes.map((outcome) => "drawnForReview" in outcome)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    const pending = pendingReviews(await readReviewBook(nodeState));
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ ruleClass: "bash npm test *", model: "keeper-rules" });
    expect(pending[0]?.state).toContain("npm test");
  });

  it("never draws a call a floor settled, since the gate had no guess", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("rm -rf dist");
    const outcome = await recordKeeperVerdict(answeredAsk(ask, denied(ask, "unsafe")), {
      nodeState,
      ratchet,
      draw: () => 0,
    });
    expect(outcome).toMatchObject({ recorded: true, answered: false });
    expect(pendingReviews(await readReviewBook(nodeState))).toEqual([]);
  });

  it("shows the call without the gate's guess or the earlier answer", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("npm test");
    await recordKeeperVerdict(answeredAsk(ask, granted(ask)), {
      nodeState,
      ratchet,
      draw: () => 0,
    });
    const [item] = pendingReviews(await readReviewBook(nodeState));
    expect(item?.state).not.toMatch(/0\.96|granted|denied|pYes/);
  });
});

describe("answerBlindReview", () => {
  it("records the second answer first, then reveals the gate's lean and the first answer", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("npm test");
    const recorded = await recordKeeperVerdict(answeredAsk(ask, granted(ask)), {
      nodeState,
      ratchet,
      draw: () => 0,
    });
    if (!recorded.recorded) throw new Error("expected a row");
    const reveal = await answerBlindReview({
      nodeState,
      recordId: recorded.recordId,
      approve: false,
      ratchet,
      now,
    });
    expect(reveal).toEqual({
      answered: true,
      recordId: recorded.recordId,
      ruleClass: "bash npm test *",
      model: "keeper-rules",
      pYes: 0.96,
      approve: false,
      inTheMoment: true,
      answeredAt: "2026-11-06T11:00:00.000Z",
      gateLeaned: true,
      agreedWithGate: false,
      agreedWithMoment: false,
    });
    const [row] = await ledgerRows(ratchet, keeperLedgerPath(nodeState));
    expect(row?.outcome).toMatchObject({
      truth: false,
      correct: false,
      source: blindReviewSource,
      note: "blind review; in the moment: granted once",
    });
    const book = await readReviewBook(nodeState);
    expect(pendingReviews(book)).toEqual([]);
    expect(blindReviewOf(book, "keeper-rules", "bash npm test *", 0.96)).toEqual({
      drawn: 1,
      answered: 1,
      agreedWithGate: 0,
      agreedWithMoment: 0,
      deniedAtBar: 1,
    });
    expect(
      await answerBlindReview({ nodeState, recordId: recorded.recordId, approve: true, ratchet }),
    ).toEqual({ answered: false, reason: "already-answered" });
  });

  it("answers only calls the draw chose", async () => {
    const nodeState = await scratchNode();
    expect(
      await answerBlindReview({ nodeState, recordId: "nope", approve: true, ratchet }),
    ).toEqual({ answered: false, reason: "not-drawn" });
  });

  it("counts the review per model and class in the report", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("npm test");
    const recorded = await recordKeeperVerdict(answeredAsk(ask, granted(ask)), {
      nodeState,
      ratchet,
      draw: () => 0,
    });
    if (!recorded.recorded) throw new Error("expected a row");
    expect((await readKeeperReport({ nodeState, ratchet })).pendingReviews).toBe(1);
    await answerBlindReview({ nodeState, recordId: recorded.recordId, approve: true, ratchet });
    const report = await readKeeperReport({ nodeState, ratchet });
    expect(report.pendingReviews).toBe(0);
    expect(report.calibration?.[0]?.review).toEqual({
      drawn: 1,
      answered: 1,
      agreedWithGate: 1,
      agreedWithMoment: 1,
      deniedAtBar: 0,
    });
    expect(await readFile(keeperReviewPath(nodeState), "utf8")).toContain('"type":"answered"');
  });
});
