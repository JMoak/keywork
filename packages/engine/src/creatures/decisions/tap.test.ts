import { describe, expect, it } from "vitest";
import { type EngineEvents, EventBus } from "../../bus.ts";
import type { AnsweredAsk, KeeperOutcome } from "./record.ts";
import { tapKeeperVerdicts } from "./tap.ts";
import { bashAsk, conversationOfPip, denied, granted } from "./testing.ts";

function tapped() {
  const bus = new EventBus<EngineEvents>();
  const recorded: AnsweredAsk[] = [];
  const tap = tapKeeperVerdicts(bus, {
    session: () => "root-1",
    context: () => conversationOfPip,
    cwd: "/work",
    now: () => new Date("2026-11-05T12:00:00.000Z"),
    record: async (answered): Promise<KeeperOutcome> => {
      recorded.push(answered);
      return { recorded: false, reason: "already-recorded" };
    },
  });
  return { bus, recorded, tap };
}

describe("tapKeeperVerdicts", () => {
  it("pairs each ask with the keeper's answer to it", async () => {
    const { bus, recorded, tap } = tapped();
    const ask = bashAsk("npm test");
    bus.emit("gate.ask", { ask });
    bus.emit("gate.permission", { decision: granted(ask) });
    await tap.flush();
    expect(recorded).toEqual([
      {
        ask,
        decision: granted(ask),
        session: "root-1",
        context: conversationOfPip,
        answeredAt: "2026-11-05T12:00:00.000Z",
        cwd: "/work",
      },
    ]);
  });

  it("ignores replays, decisions nobody asked about and answers no keeper gave", async () => {
    const { bus, recorded, tap } = tapped();
    const replayed = bashAsk("npm test");
    bus.emit("gate.ask", { ask: replayed });
    bus.emit("gate.permission", { decision: granted(replayed), replay: true });
    bus.emit("gate.permission", { decision: granted(bashAsk("make")) });
    const timedOut = bashAsk("cargo test");
    bus.emit("gate.ask", { ask: timedOut });
    bus.emit("gate.permission", { decision: { ...denied(timedOut), gate: "headless" } });
    await tap.flush();
    expect(recorded).toEqual([]);
  });

  it("stops listening when stopped", async () => {
    const { bus, recorded, tap } = tapped();
    tap.stop();
    const ask = bashAsk("npm test");
    bus.emit("gate.ask", { ask });
    bus.emit("gate.permission", { decision: granted(ask) });
    await tap.flush();
    expect(recorded).toEqual([]);
  });
});
