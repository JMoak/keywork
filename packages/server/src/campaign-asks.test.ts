import { describe, expect, it, vi } from "vitest";
import { AskQueue } from "./asks.ts";

describe("campaign permission isolation", () => {
  it("closes only the cancelled campaign's asks and keeps unrelated sessions waiting", async () => {
    const asks = new AskQueue();
    const first = asks.ask("campaign", {
      type: "tool-call",
      callId: "first",
      name: "bash",
      arguments: { command: "check" },
    });
    const second = asks.ask("ordinary", {
      type: "tool-call",
      callId: "second",
      name: "write",
      arguments: {},
    });
    asks.closeFor("campaign");
    await expect(first).resolves.toMatchObject({ approved: false });
    expect(asks.list().map((ask) => ask.callId)).toEqual(["second"]);
    expect(asks.answer("first", "granted")).toBe("already-settled");
    asks.close();
    await expect(second).resolves.toMatchObject({ approved: false });
  });

  it("does not start an unmetered decision model for campaign permission asks", async () => {
    const decider = vi.fn(async () => true);
    const asks = new AskQueue({ decider });
    const guard = asks.guardFor("campaign", { decide: false });
    const pending = guard.confirm?.({
      type: "tool-call",
      callId: "command",
      name: "bash",
      arguments: { command: "check" },
    });
    expect(decider).not.toHaveBeenCalled();
    asks.answer("command", "denied");
    await expect(pending).resolves.toMatchObject({ approved: false });
  });
});
