import { describe, expect, it } from "vitest";
import { askFactsOf } from "./facts.ts";
import { keeperFloors, keeperGateSpec } from "./gate.ts";
import { keeperRuleOracle } from "./oracles.ts";
import { loadRatchet, type Oracle, type StateLike } from "./ratchet.ts";
import { keeperState } from "./state.ts";
import { askFor, bashAsk, conversationOfPip } from "./testing.ts";

const ratchet = await loadRatchet();
const question = keeperGateSpec(ratchet, "keeper-rules").question;

const stateOfAsk = (ask: ReturnType<typeof askFor>): StateLike =>
  keeperState(ratchet, askFactsOf(ask), conversationOfPip);

const floorOf = (state: StateLike) =>
  keeperFloors(ratchet)
    .map((floor) => floor(state.text, question))
    .find((action) => action !== undefined);

describe("keeperFloors", () => {
  it("reviews what the model cannot see: opaque, cut or unplaced", () => {
    expect(floorOf(stateOfAsk(bashAsk("rg foo > out.txt")))).toBe("review");
    expect(floorOf(stateOfAsk(bashAsk(`echo ${"a".repeat(3_000)}`)))).toBe("review");
    expect(floorOf(stateOfAsk(askFor("write", { path: "a.ts" })))).toBe("review");
  });

  it("settles a one-way door in code, without asking any oracle", async () => {
    const counted = countingOracle(keeperRuleOracle(ratchet));
    const engine = new ratchet.Engine({
      oracle: counted.oracle,
      ledger: new ratchet.MemoryLedger(),
    });
    const gate = engine.gate(keeperGateSpec(ratchet, counted.oracle.id));
    const result = await gate.ask(stateOfAsk(bashAsk("rm -rf dist")), { baseline: "review" });
    expect(counted.calls()).toBe(0);
    expect(result.decision.strategy).toBe("floored");
    expect(result.ruling.action).toBe("review");
    const [row] = await engine.ledger.all();
    expect(row?.floor).toBe("review");
    expect(row?.mode).toBe("shadow");
  });
});

function countingOracle(inner: Oracle): { oracle: Oracle; calls: () => number } {
  let calls = 0;
  return {
    oracle: {
      id: inner.id,
      decide: (state, questions, opts) => {
        calls += 1;
        return inner.decide(state, questions, opts);
      },
    },
    calls: () => calls,
  };
}
