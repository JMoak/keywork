import { Agent, MockProvider, type Tool, textTurn, toolCallTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import type { ConversationModel } from "./conversation-model.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { Animator, type Scheduler } from "./motion.ts";
import type { PaneContext } from "./pane.ts";
import { keyworkNight } from "./theme.ts";

function context(focused: boolean, width = 132): PaneContext {
  return { theme: keyworkNight, focused, width, height: 20 };
}

function titleOf(pane: ConversationPane, focused: boolean): string {
  const view = pane.view(context(focused));
  return (view as { props?: { title?: string } }).props?.title ?? "";
}

function modelOf(pane: ConversationPane): ConversationModel {
  return (pane as unknown as { model: ConversationModel }).model;
}

function manualScheduler(): { schedule: Scheduler; runAll: () => void } {
  const queue: Array<() => void> = [];
  return {
    schedule: (run) => {
      queue.push(run);
      return () => {
        const at = queue.indexOf(run);
        if (at >= 0) queue.splice(at, 1);
      };
    },
    runAll: () => {
      while (queue.length > 0) queue.shift()?.();
    },
  };
}

const gatedTool = (gate: Promise<void>): Tool => ({
  name: "slow",
  description: "waits",
  parameters: { type: "object" },
  execute: async () => {
    await gate;
    return "done output";
  },
});

describe("the lifecycle stamp", () => {
  it("renders a calm idle pane with zero marks", () => {
    const pane = new ConversationPane("session-1", undefined, () => {});
    expect(titleOf(pane, true)).toBe(" session-1 ");
    expect(titleOf(pane, false)).toBe(" session-1 ");
  });

  it("fills from the working ramp while a turn runs", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "slow", arguments: {} }),
        textTurn("after"),
      ]),
      tools: [gatedTool(gate)],
    });
    const pane = new ConversationPane("session-1", agent, () => {});
    modelOf(pane).submitText("go");

    await Promise.resolve();
    const working = titleOf(pane, true);
    expect(working).toMatch(/^ [░▒▓] session-1/);

    release();
    await modelOf(pane).lastSend;
    expect(titleOf(pane, true)).toBe(" session-1 ");
  });

  it("matches the needs-you stamp to the ask-gate state exactly", async () => {
    const pane = new ConversationPane("session-1", undefined, () => {});
    expect(titleOf(pane, true)).not.toContain("█");

    const decision = pane.confirmMutation({
      type: "tool-call",
      callId: "c1",
      name: "write",
      arguments: { path: "a.txt" },
    });
    expect(titleOf(pane, true)).toContain("█ session-1");

    modelOf(pane).pendingAsk?.resolve(false);
    await decision;
    modelOf(pane).pendingAsk = undefined;
    expect(titleOf(pane, true)).not.toContain("█");
  });

  it("holds finished-unseen until focus, then drains", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const pane = new ConversationPane("session-1", agent, () => {});

    modelOf(pane).submitText("go");
    titleOf(pane, false);
    await modelOf(pane).lastSend;

    expect(titleOf(pane, false)).toBe(" █ session-1 ");
    expect(titleOf(pane, false)).toBe(" █ session-1 ");

    expect(titleOf(pane, true)).toBe(" session-1 ");
    expect(titleOf(pane, true)).toBe(" session-1 ");
  });

  it("skips the unseen hold when the pane was focused at completion", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const pane = new ConversationPane("session-1", agent, () => {});

    modelOf(pane).submitText("go");
    titleOf(pane, true);
    await modelOf(pane).lastSend;

    expect(titleOf(pane, true)).toBe(" session-1 ");
    expect(titleOf(pane, false)).toBe(" session-1 ");
  });

  it("marks an unseen failure with the missing tile", async () => {
    const failing = {
      name: "broken",
      stream(): AsyncIterable<never> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<never>> => {
              throw new Error("provider down");
            },
          }),
        };
      },
    };
    const pane = new ConversationPane("session-1", new Agent({ provider: failing }), () => {});

    modelOf(pane).submitText("go");
    titleOf(pane, false);
    await modelOf(pane).lastSend;

    expect(titleOf(pane, false)).toBe(" ▛ session-1 ");
    expect(titleOf(pane, true)).toBe(" session-1 ");
  });

  it("drains the held tile through the ramp when an animator is wired", async () => {
    const { schedule, runAll } = manualScheduler();
    const animator = new Animator({ schedule });
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const pane = new ConversationPane("session-1", agent, () => {}, undefined, undefined, {
      animator,
    });

    modelOf(pane).submitText("go");
    titleOf(pane, false);
    await modelOf(pane).lastSend;
    expect(titleOf(pane, false)).toBe(" █ session-1 ");

    const first = titleOf(pane, true);
    expect(first).toMatch(/^ [░▒▓█] session-1/);
    runAll();
    expect(titleOf(pane, true)).toBe(" session-1 ");
  });

  it("pulses the needs-you stamp between ▓ and █ through the animator", () => {
    const { schedule, runAll } = manualScheduler();
    const animator = new Animator({ schedule });
    const pane = new ConversationPane("session-1", undefined, () => {}, undefined, undefined, {
      animator,
    });

    void pane.confirmMutation({ type: "tool-call", callId: "c1", name: "write", arguments: {} });
    const seen = new Set<string>();
    for (let render = 0; render < 8; render += 1) {
      seen.add(titleOf(pane, true).trim()[0] ?? "");
      runAll();
    }
    expect(seen).toEqual(new Set(["█", "▓"]));

    modelOf(pane).pendingAsk?.resolve(false);
    modelOf(pane).pendingAsk = undefined;
    expect(titleOf(pane, true)).toBe(" session-1 ");
  });
});
