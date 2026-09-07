import { Agent, MockProvider, type Tool, textTurn, toolCallTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { lifecycleChrome, rampColor } from "./chroma.ts";
import type { ConversationModel } from "./conversation-model.ts";
import { ConversationPane, queueEditHint } from "./conversation-pane.ts";
import { parseChord } from "./keys.ts";
import { Animator, type Scheduler, tempos } from "./motion.ts";
import type { PaneContext } from "./pane.ts";
import { keyworkNight } from "./theme.ts";

const hue = rampColor(keyworkNight.ramp, 0.5);

function groundOf(pane: ConversationPane, focused: boolean): string | undefined {
  return titleRowOf(pane.view({ ...context(focused), hue })).find((cell) => cell.text === "session")
    ?.bg;
}

function borderOf(pane: ConversationPane, focused: boolean): string | undefined {
  const view = pane.view({ ...context(focused), hue }) as {
    children?: Array<{ props?: { border?: boolean; borderColor?: string } }>;
  };
  return view.children?.find((child) => child.props?.border === true)?.props?.borderColor;
}

function context(focused: boolean, width = 132): PaneContext {
  return { theme: keyworkNight, focused, width, height: 20 };
}

function titleOf(
  pane: ConversationPane,
  focused: boolean,
  extra: Partial<PaneContext> = {},
): string {
  return titleRowOf(pane.view({ ...context(focused), ...extra }))
    .map((cell) => cell.text)
    .join("");
}

interface TitleCell {
  readonly text: string;
  readonly bg: string | undefined;
}

function titleRowOf(view: unknown): TitleCell[] {
  const children = (view as { children?: Array<{ props?: { content?: unknown } }> }).children ?? [];
  const row = children.find((child) => typeof child.props?.content === "object");
  const chunks =
    (
      row?.props?.content as {
        chunks?: Array<{ text: string; bg?: { r: number; g: number; b: number } }>;
      }
    )?.chunks ?? [];
  return chunks.map((chunk) => ({ text: chunk.text, bg: hexOf(chunk.bg) }));
}

function hexOf(color: { r: number; g: number; b: number } | undefined): string | undefined {
  if (color === undefined) return undefined;
  const byte = (channel: number) =>
    Math.round(channel * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

function modelOf(pane: ConversationPane): ConversationModel {
  return (pane as unknown as { model: ConversationModel }).model;
}

const settledTitle = (stamp = "", tail = "") => new RegExp(`^ ${stamp}session-1${tail} $`);
const restingBorder = lifecycleChrome("idle", false, hue, keyworkNight).borderColor;

function manualScheduler(): { schedule: Scheduler; runAll: () => void; runOne: () => void } {
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
    runOne: () => {
      queue.shift()?.();
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
    expect(working).toMatch(/ · (?:thinking|slow) · \d+s $/);

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
    expect(pane.lifecycle()).toBe("needs-you");
    expect(groundOf(pane, true)).toBe(hue);
    expect(groundOf(pane, false)).toBe(hue);
    expect(borderOf(pane, false)).not.toBe(restingBorder);

    pane.handleKey(parseChord("n"), undefined);
    expect(await decision).toBe(false);
    expect(titleOf(pane, true)).not.toContain("█");
    expect(pane.lifecycle()).toBe("idle");
    expect(groundOf(pane, true)).not.toBe(hue);
    expect(borderOf(pane, false)).toBe(restingBorder);
  });

  it("never inverts or warms the border for finished-unseen or failed", async () => {
    const finished = new ConversationPane(
      "session-1",
      new Agent({ provider: new MockProvider([textTurn("reply")]) }),
      () => {},
    );
    modelOf(finished).submitText("go");
    await finished.settled();
    expect(finished.lifecycle()).toBe("finished-unseen");
    expect(groundOf(finished, false)).not.toBe(hue);
    expect(borderOf(finished, false)).toBe(restingBorder);

    const failed = new ConversationPane(
      "session-1",
      new Agent({ provider: new MockProvider([]) }),
      () => {},
    );
    modelOf(failed).submitText("go");
    await failed.settled();
    expect(failed.lifecycle()).toBe("failed");
    expect(groundOf(failed, false)).not.toBe(hue);
    expect(borderOf(failed, false)).toBe(restingBorder);
  });

  it("fades the inverted ground up at quick tempo and drops it on the answering keystroke", () => {
    const { schedule, runOne } = manualScheduler();
    const animator = new Animator({ schedule });
    const pane = new ConversationPane("session-1", undefined, () => {}, undefined, undefined, {
      animator,
    });
    void pane.confirmMutation({ type: "tool-call", callId: "c1", name: "write", arguments: {} });
    const grounds: string[] = [];
    for (let frame = 0; frame < 6; frame += 1) {
      grounds.push(groundOf(pane, true) ?? "none");
      runOne();
    }
    expect(grounds[0]).not.toBe(hue);
    expect(grounds.at(-1)).toBe(hue);
    expect(new Set(grounds).size).toBe(tempos.quick.steps);

    pane.handleKey(parseChord("n"), undefined);
    expect(groundOf(pane, true)).not.toBe(hue);
  });

  it("latches an unseen finish even when no frame was built while the turn ran", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const pane = new ConversationPane("session-1", agent, () => {});
    modelOf(pane).submitText("go");
    await pane.settled();
    expect(titleOf(pane, false)).toMatch(settledTitle("█ "));
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

    expect(titleOf(pane, false)).toMatch(settledTitle("▛ ", " · failed"));
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

    pane.handleKey(parseChord("n"), undefined);
    expect(titleOf(pane, true)).toBe(" session-1 ");
  });
});

describe("the masthead tile", () => {
  const frame = (pane: ConversationPane, focused: boolean, width: number, height = 24) =>
    frameRows(pane.view({ theme: keyworkNight, focused, width, height }));

  it("replaces the transcript with a block headline and one status line on an unfocused pane", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("a long enough reply")]) });
    const pane = new ConversationPane("session-1", agent, () => {});
    pane.adoptTitle("auth-retry-fix");
    modelOf(pane).submitText("go");
    await modelOf(pane).lastSend;

    const rows = frame(pane, false, 36);
    expect(rows.join("\n")).toMatch(/[▀▄]/);
    expect(rows.some((row) => row.includes("a long enough reply"))).toBe(false);
    expect(rows.find((row) => row.startsWith("idle"))).toBe("idle");
    expect(rows.at(-1)).toBe("› ");
  });

  it("follows focus: the focused pane is the working page, a draft rides under the tile", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply text")]) });
    const pane = new ConversationPane("session-1", agent, () => {});
    modelOf(pane).submitText("go");
    await modelOf(pane).lastSend;

    const focusedRows = frame(pane, true, 36);
    expect(focusedRows.some((row) => row.includes("reply text"))).toBe(true);
    expect(focusedRows.join("\n")).not.toMatch(/[▀▄]/);

    pane.handleKey(parseChord("x"), "x");
    const drafting = frame(pane, false, 36);
    expect(drafting.join("\n")).toMatch(/[▀▄]/);
    expect(drafting.at(-1)).toBe("› x");
  });

  it("never wears the masthead while an ask is pending", () => {
    const pane = new ConversationPane("session-1", undefined, () => {});
    const decision = pane.confirmMutation({
      type: "tool-call",
      callId: "c1",
      name: "write",
      arguments: { path: "a.txt" },
    });
    expect(frame(pane, false, 36).join("\n")).toContain("[y] allow");
    expect(frame(pane, true, 36).join("\n")).toContain("[y] allow");
    pane.handleKey(parseChord("n"), undefined);
    return decision;
  });

  it("shows the page for an unseen failure instead of ceremony", async () => {
    const pane = new ConversationPane(
      "session-1",
      new Agent({ provider: new MockProvider([]) }),
      () => {},
    );
    modelOf(pane).submitText("go");
    await pane.settled();
    expect(pane.lifecycle()).toBe("failed");
    expect(frame(pane, false, 36).join("\n")).not.toMatch(/[▀▄]/);
  });

  it("renders the plain page when the masthead is switched off", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply text")]) });
    const pane = new ConversationPane("session-1", agent, () => {}, undefined, undefined, {
      masthead: "off",
    });
    modelOf(pane).submitText("go");
    await modelOf(pane).lastSend;
    const rows = frame(pane, false, 36);
    expect(rows.some((row) => row.includes("reply text"))).toBe(true);
    expect(rows.join("\n")).not.toMatch(/[▀▄]/);
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
    expect(titleOf(pane, false)).toBe(" # auth-retry-fix ");
    expect(titleOf(pane, true)).toMatch(/^ (?:[.:+#] )?auth-retry-fix $/);
    const rows = frame(pane, true, 132);
    for (const row of rows) expect(row).toMatch(/^[\x20-\x7e▌›]*$/);
  });
});

describe("viewport-aware keys", () => {
  it("pages the transcript by the rows the last frame showed, not a stored guess", () => {
    const pane = new ConversationPane("session-1", undefined, () => {});
    const model = modelOf(pane);
    model.feed.entries.length = 0;
    for (let at = 1; at <= 60; at += 1) model.feed.entries.push({ kind: "info", text: `n ${at}` });
    const rows = frameRows(
      pane.view({ theme: keyworkNight, focused: true, width: 132, height: 12 }),
    );
    const shown = rows.filter((row) => /^\s*n \d+$/.test(row)).length;
    expect(shown).toBeGreaterThan(0);
    pane.handleKey(parseChord("pageup"), undefined);
    expect(model.scrollBack).toBe(shown);
  });

  it("keeps the session identity on the model, reachable through the pane", () => {
    const pane = new ConversationPane("session-1", undefined, () => {});
    pane.sessionId = "s-42";
    pane.arc = "auth";
    expect(pane.describe()).toEqual({ kind: "conversation", sessionId: "s-42" });
    expect(modelOf(pane).ledger.arc).toBe("auth");
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
    const props = (node as { props?: { content?: unknown; position?: string } }).props;
    if (props?.position === "absolute") return;
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

describe("the live header", () => {
  it("keeps spend out of the header until costs are shown", async () => {
    const agent = new Agent({
      provider: new MockProvider([textTurn("reply", { inputTokens: 12, outputTokens: 3 })]),
    });
    const pane = new ConversationPane("session-1", agent, () => {});
    modelOf(pane).submitText("go");
    await modelOf(pane).lastSend;
    expect(titleOf(pane, true)).toBe(" session-1 ");
    expect(titleOf(pane, true, { costs: true })).toMatch(/^ session-1 · \d+▸\d+ $/);
  });

  it("shows the context gauge only once it is significant, or always in the cockpit", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const pane = new ConversationPane("session-1", agent, () => {});
    modelOf(pane).submitText("go");
    await modelOf(pane).lastSend;
    expect(pane.liveStatus({ instruments: "calm" })).toBe("");
    expect(pane.liveStatus({ instruments: "cockpit" })).toMatch(/^[░▒▓█]+ \d+\/\d+k$/);
  });

  it("names the running tool with its elapsed time and counts queued prompts", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "slow", arguments: {} }),
        textTurn("after"),
        textTurn("queued reply"),
      ]),
      tools: [gatedTool(gate)],
    });
    const pane = new ConversationPane("session-1", agent, () => {});
    modelOf(pane).submitText("go");
    while (modelOf(pane).activeTool() === undefined) await new Promise((r) => setTimeout(r, 0));
    modelOf(pane).submitText("later");
    expect(pane.liveStatus({})).toMatch(/^slow · \d+s · 1 queued$/);
    release();
    await modelOf(pane).lastSend;
    pane.dispose();
  });
});

describe("slash tray pointer geometry", () => {
  function paneWithCommands(ran: string[]): ConversationPane {
    const names = ["exit", "exit-all"];
    return new ConversationPane(
      "session-1",
      undefined,
      () => {},
      undefined,
      {
        search: (query) =>
          names
            .filter((name) => name.startsWith(query.toLowerCase()))
            .map((name) => ({ name, description: name })),
        run: (name) => {
          if (!names.includes(name)) return false;
          ran.push(name);
          return true;
        },
      },
      {},
    );
  }

  function typeSlash(pane: ConversationPane, text: string): void {
    for (const character of text) pane.handleKey(parseChord(character), character);
  }

  it("hovers and clicks the rendered suggestion rows, dead outside them", () => {
    const ran: string[] = [];
    const pane = paneWithCommands(ran);
    typeSlash(pane, "/ex");
    pane.view(context(true));
    const contentHeight = 18;
    const reserved = 2 + 2 + 1;
    const firstRow = 2 + (contentHeight - reserved);
    expect(pane.handleMouse({ x: 3, y: firstRow - 1 }, { type: "move", x: 3, y: 0 })).toBe(false);
    expect(pane.handleMouse({ x: 3, y: firstRow + 1 }, { type: "move", x: 3, y: 0 })).toBe(true);
    expect(modelOf(pane).selectedSuggestion).toBe(1);
    expect(
      pane.handleMouse({ x: 3, y: firstRow + 1 }, { type: "down", x: 3, y: 0, button: 0 }),
    ).toBe(true);
    expect(ran).toEqual(["exit-all"]);
    expect(modelOf(pane).input).toBe("");
  });
});

describe("transcript elevation candidates", () => {
  function paneShowing(elevation?: "scroll-map" | "turn-age"): ConversationPane {
    const pane = new ConversationPane("session-1", undefined, () => {}, undefined, undefined, {
      ...(elevation !== undefined && { elevation }),
    });
    const feed = modelOf(pane).feed;
    feed.entries.length = 0;
    feed.entries.push(
      { kind: "user", text: "one" },
      { kind: "assistant", text: "first reply\nwith a second line\nand a third" },
      { kind: "user", text: "two" },
      { kind: "assistant", text: "second reply" },
    );
    return pane;
  }

  const stampedRows = (pane: ConversationPane) =>
    frameRows(pane.view(context(true, 80))).filter((row) => /^[█▓░] /.test(row));

  it("scroll-map turns the whole stamp column into a minimap of the transcript", () => {
    const mapped = stampedRows(paneShowing("scroll-map"));
    expect(mapped.length).toBeGreaterThan(stampedRows(paneShowing()).length);
    expect(mapped[0]?.startsWith("█")).toBe(true);
  });

  it("turn-age keeps the words identical and shifts only the ink", () => {
    expect(frameRows(paneShowing("turn-age").view(context(true, 80)))).toEqual(
      frameRows(paneShowing().view(context(true, 80))),
    );
  });
});

describe("the gauge override", () => {
  it("renders the chosen form even while the reading is calm-insignificant", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const pane = new ConversationPane("session-1", agent, () => {}, undefined, undefined, {
      gauge: "tile",
    });
    modelOf(pane).submitText("go");
    await modelOf(pane).lastSend;
    expect(pane.liveStatus({ instruments: "calm" })).toMatch(/^[⡀-⣿█][⡀-⣿█·] \d/);
  });
});

describe("queue editing rows", () => {
  it("highlights the selected queued row and shows the queue grammar while editing", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "slow", arguments: {} }),
        textTurn("after"),
        textTurn("re: one"),
        textTurn("re: two"),
      ]),
      tools: [gatedTool(gate)],
    });
    const pane = new ConversationPane("session-1", agent, () => {});
    modelOf(pane).submitText("go");
    while (modelOf(pane).activeTool() === undefined) await new Promise((r) => setTimeout(r, 0));
    modelOf(pane).submitText("one");
    modelOf(pane).submitText("two");

    pane.handleKey(parseChord("alt+up"), undefined);
    const rows = frameRows(pane.view(context(true)));
    expect(rows).toContain(queueEditHint);
    expect(rows.some((row) => row.startsWith("⋯ two") && row.length > "⋯ two".length)).toBe(true);
    expect(rows).toContain("⋯ one");

    pane.handleKey(parseChord("escape"), undefined);
    expect(frameRows(pane.view(context(true)))).not.toContain(queueEditHint);
    release();
    await pane.settled();
    pane.dispose();
  });
});
