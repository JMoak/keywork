import { Agent, MockProvider, type Tool, textTurn, toolCallTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { lifecycleChrome, rampColor } from "./chroma.ts";
import type { ConversationModel } from "./conversation-model.ts";
import { ConversationPane, queueEditHint } from "./conversation-pane.ts";
import { parseChord } from "./keys.ts";
import { askArmingMs } from "./mutation-ask.ts";
import { keyworkNight } from "./palette.ts";
import type { PaneContext } from "./pane.ts";

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

function clock(): { now: () => number; pass: (ms: number) => void } {
  let ms = 0;
  return {
    now: () => ms,
    pass: (by) => {
      ms += by;
    },
  };
}

function armAsk(pane: ConversationPane, time: ReturnType<typeof clock>): void {
  pane.view(context(true));
  time.pass(askArmingMs);
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
  it("matches the needs-you stamp to the ask-gate state exactly", async () => {
    const time = clock();
    const pane = new ConversationPane("session-1", undefined, () => {}, undefined, undefined, {
      ports: { now: time.now },
    });
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

    armAsk(pane, time);
    pane.handleKey(parseChord("n"), undefined);
    expect(pane.lifecycle()).toBe("needs-you");
    pane.handleKey(parseChord("u"), undefined);
    expect(await decision).toBe(false);
    expect(titleOf(pane, true)).not.toContain("█");
    expect(pane.lifecycle()).toBe("idle");
    expect(groundOf(pane, true)).not.toBe(hue);
    expect(borderOf(pane, false)).toBe(restingBorder);
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

  it("spells out what [a] will remember under a bash ask, and nothing under a write ask", () => {
    const time = clock();
    const pane = new ConversationPane("session-1", undefined, () => {}, undefined, undefined, {
      ports: { now: time.now },
    });
    const shell = pane.confirmMutation({
      type: "tool-call",
      callId: "c1",
      name: "bash",
      arguments: { command: "git push origin main" },
    });
    armAsk(pane, time);
    const rows = frame(pane, true, 80);
    const askAt = rows.findIndex((row) => row.includes("[a] always"));
    expect(askAt).toBeGreaterThanOrEqual(0);
    expect(rows[askAt]).toContain("? bash git push origin main");
    expect(rows[askAt + 1]).toBe("  [a] remembers bash git push * for this session");
    pane.handleKey(parseChord("n"), undefined);
    const asking = frame(pane, true, 80).join("\n");
    expect(asking).toContain("why?  [u] unsafe  [n] not now  [o] other, say why");
    expect(asking).not.toContain("remembers");
    pane.handleKey(parseChord("o"), undefined);
    const noting = frame(pane, true, 80);
    expect(noting.join("\n")).toContain("say why · enter sends · esc skips");
    expect(noting).toContain("  › ▌");
    pane.handleKey(parseChord("enter"), undefined);

    const write = pane.confirmMutation({
      type: "tool-call",
      callId: "c2",
      name: "write",
      arguments: { path: "a.txt" },
    });
    armAsk(pane, time);
    const writeRows = frame(pane, true, 80).join("\n");
    expect(writeRows).toContain("[y] allow  [n] deny");
    expect(writeRows).not.toContain("remembers");
    pane.handleKey(parseChord("n"), undefined);
    pane.handleKey(parseChord("n"), undefined);
    return Promise.all([shell, write]);
  });

  it("never wears the masthead while an ask is pending, and shows the controls once armed", () => {
    const time = clock();
    const pane = new ConversationPane("session-1", undefined, () => {}, undefined, undefined, {
      ports: { now: time.now },
    });
    const decision = pane.confirmMutation({
      type: "tool-call",
      callId: "c1",
      name: "write",
      arguments: { path: "a.txt" },
    });
    expect(frame(pane, false, 36).join("\n")).toContain("[y] allow");
    const unarmed = frame(pane, true, 36).join("\n");
    expect(unarmed).toContain("? write a.txt");
    expect(unarmed).not.toContain("[y] allow");
    time.pass(askArmingMs);
    expect(frame(pane, true, 36).join("\n")).toContain("[y] allow");
    pane.handleKey(parseChord("n"), undefined);
    pane.handleKey(parseChord("n"), undefined);
    return decision;
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

describe("image paste into the prompt", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  function pane(files: Record<string, Uint8Array>): ConversationPane {
    return new ConversationPane(
      "session-1",
      new Agent({ provider: new MockProvider([]) }),
      () => {},
      undefined,
      undefined,
      { readImage: (path) => files[path] },
    );
  }

  it("turns a pasted image path into a chip and leaves other pastes as text", () => {
    const subject = pane({ "/shots/one.png": png });
    subject.handlePaste("/shots/one.png");
    expect(subject.model.input).toBe("[image #1, png 4 B] ");
    expect(subject.model.editor.attachedImages()).toEqual([
      { type: "image", mediaType: "image/png", data: Buffer.from(png).toString("base64") },
    ]);
    subject.handlePaste("/shots/missing.png");
    expect(subject.model.input).toBe("[image #1, png 4 B] /shots/missing.png");
  });
});
