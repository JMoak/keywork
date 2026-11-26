import { EventLog, type ModelWaitChange } from "@keywork/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { followModelWaits, shortestReportedWaitMs } from "./serve-model-waits.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("waits on a model", () => {
  it("reports a wait only once it has lasted two seconds, keeps it across retries, and ends it when the model answers", () => {
    vi.useFakeTimers();
    const log = new EventLog();
    const waits = followModelWaits(log, (session) => ({
      creature: session === "s2" ? "lark" : null,
      server: null,
    }));
    const changes: ModelWaitChange[] = [];
    waits.subscribe((change) => changes.push(change));
    const waiting = (session: string, reason: "rate-limited" | "overloaded" | "unreachable") =>
      log.record(session, "turn.waiting", {
        reason,
        until: "2026-11-24T10:00:30.000Z",
        attempt: 2,
      });

    waiting("s1", "rate-limited");
    vi.advanceTimersByTime(shortestReportedWaitMs - 1);
    log.record("s1", "turn.delta", { delta: { type: "text", text: "Here." } });
    waiting("s2", "overloaded");
    waiting("s3", "unreachable");
    vi.advanceTimersByTime(shortestReportedWaitMs);
    log.record("s2", "turn.resumed", { attempt: 2 });
    waiting("s2", "overloaded");
    vi.advanceTimersByTime(shortestReportedWaitMs);
    const standing = waits.list();
    log.record("s2", "turn.completed", {
      message: { role: "assistant", parts: [] },
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const lark = {
      session: "s2",
      creature: "lark",
      server: null,
      reason: "busy",
      since: expect.any(String),
    };
    expect(standing).toEqual([lark]);
    expect(changes).toEqual([
      { change: "waiting", wait: lark },
      { change: "over", wait: lark },
    ]);
    expect(waits.list()).toEqual([]);
    waits.close();
  });
});
