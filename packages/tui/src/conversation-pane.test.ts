import { Agent, MockProvider, type Tool, textTurn, toolCallTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import type { ConversationModel } from "./conversation-model.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { parseChord } from "./keys.ts";
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

const settledTitle = (stamp = "") => new RegExp(`^ ${stamp}session-1 · ░ \\d+ $`);

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
    expect(titleOf(pane, true)).toMatch(settledTitle());
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

    expect(titleOf(pane, false)).toMatch(settledTitle("█ "));
    expect(titleOf(pane, false)).toMatch(settledTitle("█ "));

    expect(titleOf(pane, true)).toMatch(settledTitle());
    expect(titleOf(pane, true)).toMatch(settledTitle());
  });

  it("skips the unseen hold when the pane was focused at completion", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const pane = new ConversationPane("session-1", agent, () => {});

    modelOf(pane).submitText("go");
    titleOf(pane, true);
    await modelOf(pane).lastSend;

    expect(titleOf(pane, true)).toMatch(settledTitle());
    expect(titleOf(pane, false)).toMatch(settledTitle());
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

    expect(titleOf(pane, false)).toMatch(settledTitle("▛ "));
    expect(titleOf(pane, true)).toMatch(settledTitle());
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
    expect(titleOf(pane, false)).toMatch(settledTitle("█ "));

    const first = titleOf(pane, true);
    expect(first).toMatch(/^ [░▒▓█] session-1/);
    runAll();
    expect(titleOf(pane, true)).toMatch(settledTitle());
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

describe("the masthead tile", () => {
  const frame = (pane: ConversationPane, focused: boolean, width: number, height = 24) =>
    frameRows(pane.view({ theme: keyworkNight, focused, width, height }));

  it("replaces the transcript with a block headline and one status line below the threshold", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("a long enough reply")]) });
    const pane = new ConversationPane("session-1", agent, () => {});
    pane.adoptTitle("auth-retry-fix");
    modelOf(pane).submitText("go");
    await modelOf(pane).lastSend;

    const rows = frame(pane, true, 36);
    expect(rows.join("\n")).toMatch(/[▀▄]/);
    expect(rows.some((row) => row.includes("a long enough reply"))).toBe(false);
    expect(rows.find((row) => row.startsWith("idle"))).toMatch(/^idle · ░ \d+$/);
    expect(rows.at(-1)).toBe("› ▌");
  });

  it("yields to input: a draft brings the transcript back, clearing it restores the tile", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply text")]) });
    const pane = new ConversationPane("session-1", agent, () => {});
    modelOf(pane).submitText("go");
    await modelOf(pane).lastSend;

    pane.handleKey(parseChord("x"), "x");
    const typing = frame(pane, true, 36);
    expect(typing.some((row) => row.includes("reply text"))).toBe(true);
    expect(typing.join("\n")).not.toMatch(/[▀▄]/);

    pane.handleKey(parseChord("backspace"), undefined);
    expect(frame(pane, true, 36).join("\n")).toMatch(/[▀▄]/);
  });

  it("never wears the masthead while an ask is pending", () => {
    const pane = new ConversationPane("session-1", undefined, () => {});
    const decision = pane.confirmMutation({
      type: "tool-call",
      callId: "c1",
      name: "write",
      arguments: { path: "a.txt" },
    });
    expect(frame(pane, true, 36).join("\n")).toContain("[y] allow");
    modelOf(pane).pendingAsk?.resolve(false);
    return decision;
  });

  it("reports working and failed states on the status line", async () => {
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
    expect(frame(pane, false, 36).some((row) => row.startsWith("working"))).toBe(true);
    release();
    await modelOf(pane).lastSend;
    expect(frame(pane, false, 36).some((row) => row.startsWith("idle"))).toBe(true);
  });

  it("sets the headline in caps and keeps ASCII stamps at glyph tier 0", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const pane = new ConversationPane("session-1", agent, () => {}, undefined, undefined, {
      glyphs: { glyphTier: 0, nerdFont: false },
    });
    pane.adoptTitle("auth-retry-fix");
    modelOf(pane).submitText("go");
    titleOf(pane, false);
    await modelOf(pane).lastSend;

    expect(frame(pane, false, 36)).toContain("AUTH RETRY FIX");
    expect(titleOf(pane, false)).toMatch(/^ # auth-retry-fix · \. \d+ $/);
    expect(titleOf(pane, true)).toMatch(/^ [.:+#] auth-retry-fix | auth-retry-fix · \. \d+ $/);
    const rows = frame(pane, true, 132);
    for (const row of rows) expect(row).toMatch(/^[\x20-\x7e▌›]*$/);
  });
});

describe("keyboard disclosure in the pane", () => {
  it("shows the disclosure hint while the fold cursor is active", async () => {
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "slow", arguments: {} }),
        textTurn("after"),
      ]),
      tools: [gatedTool(Promise.resolve())],
    });
    const pane = new ConversationPane("session-1", agent, () => {});
    modelOf(pane).submitText("go");
    await modelOf(pane).lastSend;

    expect(pane.handleKey(parseChord("shift+tab"), undefined)).toBe(true);
    const rows = frameRows(pane.view(context(true)));
    expect(rows.some((row) => row.startsWith("disclose · tab toggles"))).toBe(true);
    pane.handleKey(parseChord("escape"), undefined);
    expect(frameRows(pane.view(context(true))).some((row) => row.startsWith("disclose ·"))).toBe(
      false,
    );
  });
});

function frameRows(view: ReturnType<ConversationPane["view"]>): string[] {
  const rows: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const props = (node as { props?: { content?: unknown } }).props;
    const content = props?.content;
    if (typeof content === "string") rows.push(content);
    else if (content !== undefined && typeof content === "object") {
      const chunks = (content as { chunks?: Array<{ text: string }> }).chunks;
      if (chunks !== undefined) rows.push(chunks.map((chunk) => chunk.text).join(""));
    }
    for (const child of (node as { children?: unknown[] }).children ?? []) visit(child);
  };
  visit(view);
  return rows;
}
