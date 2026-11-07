import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keeperGateId, keeperLabelSource } from "./gate.ts";
import { loadRatchet, type Ratchet } from "./ratchet.ts";
import { keeperLedgerPath, recordKeeperVerdict } from "./record.ts";
import {
  answeredAsk,
  bashAsk,
  denied,
  granted,
  ledgerRows,
  scratchNode,
  scriptedDecider,
  yesWith,
} from "./testing.ts";

const ratchet = await loadRatchet();

describe("recordKeeperVerdict", () => {
  it("writes a ratchet row per answered ask under the node state, in decisions/", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("npm test");
    const outcome = await recordKeeperVerdict(answeredAsk(ask, granted(ask)), { nodeState });
    expect(outcome).toMatchObject({
      recorded: true,
      ruleClass: "bash npm test *",
      recommendation: "act",
      pYes: 0.96,
      answered: true,
      agreed: true,
    });
    expect(keeperLedgerPath(nodeState)).toBe(
      join(nodeState, "decisions", "keeper-would-approve.jsonl"),
    );
    const [row] = await ledgerRows(ratchet, keeperLedgerPath(nodeState));
    expect(row).toMatchObject({
      gateId: keeperGateId,
      questionId: keeperGateId,
      kind: "judge",
      oracle: "keeper-rules",
      evidenceVersion: "keeper-would-approve/1 keeper-rules",
      mode: "shadow",
      soft: "act",
      action: "review",
      untrusted: ["ask"],
      outcome: {
        at: "2026-11-05T12:00:00.000Z",
        correct: true,
        truth: true,
        source: keeperLabelSource,
        note: "granted once",
      },
    });
    expect(row?.tags).toEqual([
      `keeper:call:session-1:${ask.callId}`,
      "session:session-1",
      "class:bash npm test *",
      "tool:bash",
      "thread:conversation",
      "creature:pip",
      "workshop:host",
    ]);
  });

  it("labels a denial with the keeper's reason and scores the gate's lean against it", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("npm publish");
    await recordKeeperVerdict(answeredAsk(ask, denied(ask, "unsafe")), { nodeState });
    const [row] = await ledgerRows(ratchet, keeperLedgerPath(nodeState));
    expect(row?.soft).toBe("review");
    expect(row?.outcome).toMatchObject({ truth: false, correct: true, note: "denied: unsafe" });
  });

  it("keeps the ask text out of the ledger and the verdict out of the state", async () => {
    const [grantedNode, deniedNode] = [await scratchNode(), await scratchNode()];
    const ask = bashAsk("npm test -- --token=abcdef");
    await recordKeeperVerdict(answeredAsk(ask, granted(ask)), { nodeState: grantedNode });
    await recordKeeperVerdict(answeredAsk(ask, denied(ask, "other")), { nodeState: deniedNode });
    const [approvedRow] = await ledgerRows(ratchet, keeperLedgerPath(grantedNode));
    const [deniedRow] = await ledgerRows(ratchet, keeperLedgerPath(deniedNode));
    expect(approvedRow?.stateHash).toBe(deniedRow?.stateHash);
    expect(approvedRow?.state).toBeUndefined();
    expect(await readFile(keeperLedgerPath(grantedNode), "utf8")).not.toContain("abcdef");
  });

  it("records only fresh answers a keeper gave, and never a not-now", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("npm test");
    const skips = [
      [{ ...granted(ask), gate: "quiet" as const, asked: false }, "not-a-keeper-verdict"],
      [{ ...denied(ask), gate: "headless" as const }, "not-a-keeper-verdict"],
      [{ ...granted(ask, "session"), asked: false }, "not-a-keeper-verdict"],
      [{ ...granted(ask), callId: "another-call" }, "mismatched-ask"],
      [denied(ask, "not-now"), "not-now"],
    ] as const;
    for (const [decision, reason] of skips) {
      expect(await recordKeeperVerdict(answeredAsk(ask, decision), { nodeState })).toEqual({
        recorded: false,
        reason,
      });
    }
    await expect(readFile(keeperLedgerPath(nodeState), "utf8")).rejects.toThrow();
  });

  it("records each call once", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("npm test");
    await recordKeeperVerdict(answeredAsk(ask, granted(ask)), { nodeState });
    const again = await recordKeeperVerdict(answeredAsk(ask, granted(ask)), { nodeState });
    expect(again).toEqual({ recorded: false, reason: "already-recorded" });
    expect(await ledgerRows(ratchet, keeperLedgerPath(nodeState))).toHaveLength(1);
  });

  it("asks the configured decide model instead of the rule oracle", async () => {
    const nodeState = await scratchNode();
    const decider = scriptedDecider(yesWith(0.97, 0.0003));
    const ask = bashAsk("python migrate.py");
    const outcome = await recordKeeperVerdict(answeredAsk(ask, denied(ask, "unsafe")), {
      nodeState,
      decider,
    });
    expect(outcome).toMatchObject({ recorded: true, recommendation: "act", agreed: false });
    expect(decider.requests[0]?.state).toContain(
      "[untrusted ask: the command as the agent wrote it]",
    );
    const [row] = await ledgerRows(ratchet, keeperLedgerPath(nodeState));
    expect(row).toMatchObject({
      oracle: "decide:local/nimble-0.8b",
      model: "nimble-0.8b@2026-10-01",
      evidenceVersion: "keeper-would-approve/1 decide:local/nimble-0.8b",
      cost: 0.0003,
      action: "review",
      outcome: { truth: false, correct: false },
    });
  });

  it("holds a one-way door at review without asking the decide model", async () => {
    const nodeState = await scratchNode();
    const decider = scriptedDecider(yesWith(0.99));
    const ask = bashAsk("rm -rf dist");
    const outcome = await recordKeeperVerdict(answeredAsk(ask, granted(ask)), {
      nodeState,
      decider,
    });
    expect(outcome).toMatchObject({
      recorded: true,
      ruleClass: "one-way door",
      recommendation: "review",
      answered: false,
    });
    expect(decider.requests).toHaveLength(0);
    const [row] = await ledgerRows(ratchet, keeperLedgerPath(nodeState));
    expect(row).toMatchObject({ floor: "review", strategy: "floored", soft: "review" });
    expect(row?.tags).toContain("door:one-way");
  });

  it("appends answers that arrive together one after another, each with its label", async () => {
    const nodeState = await scratchNode();
    const asks = ["npm test", "make", "cargo test", "npm publish", "go vet ./..."].map(bashAsk);
    await Promise.all(
      asks.map((ask) => recordKeeperVerdict(answeredAsk(ask, granted(ask)), { nodeState })),
    );
    const rows = await ledgerRows(ratchet, keeperLedgerPath(nodeState));
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.outcome?.source === keeperLabelSource)).toBe(true);
  });

  it("reports itself unavailable instead of throwing into the ask path", async () => {
    const broken: Ratchet = {
      ...ratchet,
      Engine: class {
        constructor() {
          throw new Error("engine exploded");
        }
      } as unknown as Ratchet["Engine"],
    };
    const ask = bashAsk("npm test");
    const outcome = await recordKeeperVerdict(answeredAsk(ask, granted(ask)), {
      nodeState: await scratchNode(),
      ratchet: broken,
    });
    expect(outcome).toEqual({ recorded: false, reason: "unavailable", detail: "engine exploded" });
  });
});
