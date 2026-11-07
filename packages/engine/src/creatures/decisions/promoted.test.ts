import { describe, expect, it } from "vitest";
import { keeperLedgerPath } from "./files.ts";
import { promoteKeeperClass } from "./promote.ts";
import {
  decideForKeeper,
  keeperMinAudits,
  keeperOverturnSource,
  overturnKeeperDecision,
  promotedTag,
  wasDecidedForYou,
} from "./promoted.ts";
import { readPromotionBook } from "./promotions.ts";
import { loadRatchet } from "./ratchet.ts";
import { type KeeperCall, recordKeeperVerdict } from "./record.ts";
import {
  answeredAsk,
  bashAsk,
  conversationOfPip,
  denied,
  granted,
  ledgerRows,
  promotableClass,
  promotableNode,
  scratchNode,
  scriptedDecider,
  yesWith,
} from "./testing.ts";

const ratchet = await loadRatchet();
const promotedAt = () => new Date("2026-11-06T10:00:00.000Z");

function makeCall(jobs: number): KeeperCall {
  return {
    ask: bashAsk(`make build JOBS=${jobs}`),
    session: "session-live",
    context: conversationOfPip,
  };
}

async function promotedNode(): Promise<string> {
  const nodeState = await promotableNode(ratchet);
  const outcome = await promoteKeeperClass({
    nodeState,
    ruleClass: promotableClass,
    ratchet,
    now: promotedAt,
  });
  if (!outcome.promoted) throw new Error(outcome.sentence);
  return nodeState;
}

describe("decideForKeeper", () => {
  it("leaves every ask with the keeper while nothing is promoted, and writes nothing", async () => {
    const nodeState = await scratchNode();
    expect(await decideForKeeper(makeCall(1), { nodeState, ratchet })).toEqual({
      decidedForYou: false,
      reason: "not-promoted",
      ruleClass: promotableClass,
    });
    expect(await readPromotionBook(nodeState)).toEqual({ active: [], demotions: [] });
  });

  it("decides a promoted call for the keeper and still logs it, unlabelled", async () => {
    const nodeState = await promotedNode();
    const ruling = await decideForKeeper(makeCall(9001), { nodeState, ratchet, auditRate: 0 });
    expect(ruling).toMatchObject({
      decidedForYou: true,
      ruleClass: promotableClass,
      pYes: 0.96,
      promotion: { ruleClass: promotableClass, bar: 0.96 },
    });
    const row = (await ledgerRows(ratchet, keeperLedgerPath(nodeState))).at(-1);
    expect(row).toMatchObject({ mode: "enforce", action: "act", soft: "act" });
    expect(row?.tags).toContain(promotedTag);
    expect(row?.outcome).toBeUndefined();
    expect(row !== undefined && wasDecidedForYou(row)).toBe(true);
  }, 120_000);

  it("keeps an ask in another class, or for a one-way door, with the keeper", async () => {
    const nodeState = await promotedNode();
    for (const command of ["npm test", "rm -rf dist"]) {
      const call = { ...makeCall(0), ask: bashAsk(command) };
      expect(await decideForKeeper(call, { nodeState, ratchet })).toMatchObject({
        decidedForYou: false,
        reason: "not-promoted",
      });
    }
  }, 120_000);

  it("sends a blind review to the keeper at the audit rate and labels it with the answer", async () => {
    const nodeState = await promotedNode();
    const call = makeCall(9002);
    const ruling = await decideForKeeper(call, { nodeState, ratchet, auditRate: 1 });
    expect(ruling).toMatchObject({ decidedForYou: false, reason: "blind-review" });
    const answer = await recordKeeperVerdict(
      answeredAsk(call.ask, granted(call.ask), { session: call.session }),
      { nodeState, ratchet, draw: () => 1 },
    );
    const rows = await ledgerRows(ratchet, keeperLedgerPath(nodeState));
    const audited = rows.at(-1);
    expect(rows).toHaveLength(201);
    expect(audited?.tags).toContain("audit");
    expect(audited?.outcome).toMatchObject({ truth: true, source: "keywork:person" });
    expect(answer).toMatchObject({ recorded: true, recordId: audited?.id });
  }, 120_000);

  it("hands the class back when the promoted model is not the one answering", async () => {
    const nodeState = await promotedNode();
    const decider = scriptedDecider(yesWith(0.99));
    expect(await decideForKeeper(makeCall(9003), { nodeState, ratchet, decider })).toMatchObject({
      decidedForYou: false,
      reason: "model-moved",
    });
  }, 120_000);

  it("demotes the class when blind reviews of decided calls drift below the promise", async () => {
    const nodeState = await promotedNode();
    const options = { nodeState, ratchet, auditRate: 1, draw: () => 1 };
    for (let jobs = 0; jobs < keeperMinAudits; jobs += 1) {
      const call = makeCall(10_000 + jobs);
      await decideForKeeper(call, options);
      const verdict = jobs === 0 ? denied(call.ask, "unsafe") : granted(call.ask);
      await recordKeeperVerdict(answeredAsk(call.ask, verdict, { session: call.session }), options);
    }
    expect(await decideForKeeper(makeCall(20_000), options)).toMatchObject({
      decidedForYou: false,
      reason: "drifted",
    });
    expect(await readPromotionBook(nodeState)).toMatchObject({
      active: [],
      demotions: [{ ruleClass: promotableClass, by: "audits" }],
    });
  }, 120_000);
});

describe("overturnKeeperDecision", () => {
  it("labels a decision the keeper overturns as wrong and hands the class back", async () => {
    const nodeState = await promotedNode();
    const ruling = await decideForKeeper(makeCall(9004), { nodeState, ratchet, auditRate: 0 });
    if (!ruling.decidedForYou) throw new Error("expected a decision");
    const outcome = await overturnKeeperDecision({ nodeState, recordId: ruling.recordId, ratchet });
    expect(outcome).toMatchObject({
      overturned: true,
      recordId: ruling.recordId,
      ruleClass: promotableClass,
      demoted: [{ ruleClass: promotableClass }],
    });
    const row = (await ledgerRows(ratchet, keeperLedgerPath(nodeState))).at(-1);
    expect(row?.outcome).toMatchObject({ truth: false, source: keeperOverturnSource });
    expect(await readPromotionBook(nodeState)).toMatchObject({
      active: [],
      demotions: [{ by: "overturn", reason: `overturned ${ruling.recordId}` }],
    });
    expect(await overturnKeeperDecision({ nodeState, recordId: ruling.recordId, ratchet })).toEqual(
      { overturned: false, reason: "already-overturned" },
    );
    expect(await decideForKeeper(makeCall(9005), { nodeState, ratchet })).toMatchObject({
      decidedForYou: false,
      reason: "not-promoted",
    });
  }, 120_000);

  it("overturns only what was decided for the keeper", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("npm test");
    const recorded = await recordKeeperVerdict(answeredAsk(ask, granted(ask)), {
      nodeState,
      ratchet,
      draw: () => 1,
    });
    if (!recorded.recorded) throw new Error("expected a row");
    expect(
      await overturnKeeperDecision({ nodeState, recordId: recorded.recordId, ratchet }),
    ).toEqual({ overturned: false, reason: "not-decided-for-you" });
  });
});
