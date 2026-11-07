import { describe, expect, it } from "vitest";
import { demoteKeeperClass, evidenceNeeded, promoteKeeperClass } from "./promote.ts";
import { readPromotionBook } from "./promotions.ts";
import { loadRatchet } from "./ratchet.ts";
import { readKeeperReport, readKeeperRows } from "./report.ts";
import { answerBlindReview, drawForBlindReview } from "./review.ts";
import { answerAll, promotableClass, promotableNode, scratchNode } from "./testing.ts";

const ratchet = await loadRatchet();
const now = () => new Date("2026-11-06T10:00:00.000Z");

describe("promoteKeeperClass", () => {
  it("refuses a one-way door on principle, whatever evidence it holds", async () => {
    const nodeState = await scratchNode();
    for (const ruleClass of ["one-way door", "bash rm -rf dist", "bash git push --force *"]) {
      expect(await promoteKeeperClass({ nodeState, ruleClass, ratchet })).toEqual({
        promoted: false,
        refusal: "one-way-door",
        sentence:
          `"${ruleClass}" is a one-way door: destructive forms in keywork's K9 sense stay ` +
          "ask-only, and no evidence promotes them.",
      });
    }
  });

  it("takes one rule class by name, never every class at once", async () => {
    const outcome = await promoteKeeperClass({
      nodeState: await scratchNode(),
      ruleClass: "all classes",
      ratchet,
    });
    expect(outcome).toMatchObject({ promoted: false, refusal: "every-class" });
  });

  it("says when a class has no answered asks", async () => {
    const outcome = await promoteKeeperClass({
      nodeState: await scratchNode(),
      ruleClass: "bash cargo test *",
      ratchet,
    });
    expect(outcome).toEqual({
      promoted: false,
      refusal: "unanswered",
      sentence: 'No answered asks in "bash cargo test *" yet.',
    });
  });

  it("refuses before the planned sample and names the evidence it needs", async () => {
    const nodeState = await scratchNode();
    await answerAll({ nodeState, ratchet, draw: () => 1 }, ["npm test", "npm test -s"], "granted");
    const outcome = await promoteKeeperClass({ nodeState, ruleClass: "bash npm test *", ratchet });
    expect(outcome).toMatchObject({ promoted: false, refusal: "uncalibrated" });
    expect(outcome.sentence).toBe(
      `${evidenceNeeded(ratchet, "bash npm test *")} Today, for keeper-rules: fitting, 2 of the ` +
        "50 answers the bar is fitted on.",
    );
    expect(evidenceNeeded(ratchet, "bash npm test *")).toContain(
      "then the first 149 distinct calls after them that clear it, at most 10 from one session",
    );
    expect((await readPromotionBook(nodeState)).active).toEqual([]);
  });

  it("promotes one class on the planned sample and records it reversibly", async () => {
    const nodeState = await promotableNode(ratchet);
    const outcome = await promoteKeeperClass({
      nodeState,
      ruleClass: promotableClass,
      ratchet,
      now,
    });
    expect(outcome).toMatchObject({
      promoted: true,
      promotion: {
        ruleClass: promotableClass,
        model: "keeper-rules",
        evidenceVersion: "keeper-would-approve/1 keeper-rules",
        bar: 0.96,
        sampleSize: 149,
        errors: 0,
        by: "keeper",
        at: "2026-11-06T10:00:00.000Z",
      },
    });
    if (!outcome.promoted) throw new Error("expected a promotion");
    expect(outcome.promotion.lowerBound).toBeGreaterThanOrEqual(0.98);
    expect((await readPromotionBook(nodeState)).active).toEqual([outcome.promotion]);
    expect(await readKeeperReport({ nodeState, ratchet })).toMatchObject({
      mode: "enforce",
      enforced: true,
      promotions: [outcome.promotion],
    });
    expect(
      await promoteKeeperClass({ nodeState, ruleClass: promotableClass, ratchet }),
    ).toMatchObject({ promoted: false, refusal: "promoted" });
  }, 120_000);

  it("refuses when the blind review denied a call above the bar", async () => {
    const nodeState = await promotableNode(ratchet);
    const last = (await readKeeperRows({ nodeState, ratchet })).at(-1);
    if (last === undefined) throw new Error("expected rows");
    await drawForBlindReview(nodeState, {
      recordId: last.id,
      ruleClass: promotableClass,
      model: "keeper-rules",
      pYes: 0.96,
      state: "make build",
      drawnAt: "2026-11-06T09:00:00.000Z",
    });
    await answerBlindReview({ nodeState, recordId: last.id, approve: false, ratchet });
    expect(
      await promoteKeeperClass({ nodeState, ruleClass: promotableClass, ratchet }),
    ).toMatchObject({ promoted: false, refusal: "blind-review" });
  }, 120_000);

  it("scopes a promotion through a creature to that creature", async () => {
    const nodeState = await promotableNode(ratchet);
    await promoteKeeperClass({ nodeState, ruleClass: promotableClass, creature: "pip", ratchet });
    expect((await readKeeperReport({ nodeState, ratchet, creature: "pip" })).enforced).toBe(true);
    expect((await readKeeperReport({ nodeState, ratchet, creature: "mo" })).enforced).toBe(false);
  }, 120_000);
});

describe("demoteKeeperClass", () => {
  it("hands a promoted class back and asks for a fresh sample before promoting again", async () => {
    const nodeState = await promotableNode(ratchet);
    await promoteKeeperClass({ nodeState, ruleClass: promotableClass, ratchet, now });
    const later = () => new Date("2099-01-01T00:00:00.000Z");
    const demoted = await demoteKeeperClass({
      nodeState,
      ruleClass: promotableClass,
      ratchet,
      now: later,
    });
    expect(demoted).toMatchObject({
      demoted: true,
      demotion: { ruleClass: promotableClass, by: "keeper", at: "2099-01-01T00:00:00.000Z" },
      promotions: [{ ruleClass: promotableClass, model: "keeper-rules" }],
    });
    expect(await readPromotionBook(nodeState)).toMatchObject({ active: [], demotions: [{}] });
    expect((await readKeeperReport({ nodeState, ratchet })).enforced).toBe(false);
    expect(
      await demoteKeeperClass({ nodeState, ruleClass: promotableClass, ratchet }),
    ).toMatchObject({ demoted: false });
    expect(
      await promoteKeeperClass({ nodeState, ruleClass: promotableClass, ratchet }),
    ).toMatchObject({ promoted: false, refusal: "unanswered" });
  }, 120_000);
});
