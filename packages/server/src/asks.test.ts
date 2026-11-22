import type { ToolCallPart } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { type AskEnding, type AskFollower, AskQueue, type PendingAsk } from "./asks.ts";

function call(callId: string): ToolCallPart {
  return { type: "tool-call", callId, name: "bash", arguments: { command: "git push" } };
}

function following(asks: AskQueue) {
  const heard: string[] = [];
  const follower: AskFollower = {
    asked: (ask: PendingAsk) => heard.push(`asked ${ask.sessionId} ${ask.callId}`),
    settled: (ask: PendingAsk, ending: AskEnding) => heard.push(`${ending} ${ask.callId}`),
  };
  return { heard, unfollow: asks.follow(follower) };
}

describe("following the ask queue", () => {
  it("hears each ask as it joins the queue and how it left: answered, timed out or closed", async () => {
    const asks = new AskQueue({ timeoutMs: 5 });
    const { heard } = following(asks);
    const granted = asks.ask("s1", call("granted"));
    const denied = asks.ask("s1", call("denied"));
    const closed = asks.ask("s2", call("closed"));
    asks.answer("granted", "granted");
    asks.answer("denied", "denied");
    asks.closeFor("s2");
    await Promise.all([granted, denied, closed]);
    await asks.ask("s3", call("timed-out"));

    expect(heard).toEqual([
      "asked s1 granted",
      "asked s1 denied",
      "asked s2 closed",
      "granted granted",
      "denied denied",
      "lapsed closed",
      "asked s3 timed-out",
      "lapsed timed-out",
    ]);
  });

  it("hears an ask a decider answered for the keeper, and nothing once unfollowed", async () => {
    const asks = new AskQueue({ decider: async () => ({ approved: true, gate: "headless" }) });
    const { heard, unfollow } = following(asks);
    await asks.ask("s1", call("decided"));
    unfollow();
    const later = asks.ask("s1", call("unheard"));
    asks.close();
    await later;
    expect(heard).toEqual(["asked s1 decided", "granted decided"]);
  });
});
