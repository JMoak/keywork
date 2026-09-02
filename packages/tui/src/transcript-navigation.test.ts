import { Agent, MockProvider, type Tool, textTurn, toolCallTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationModel } from "./conversation-model.ts";
import { parseChord } from "./keys.ts";
import { TranscriptFeed } from "./transcript-feed.ts";
import { TranscriptNavigation } from "./transcript-navigation.ts";

const echoTool: Tool = {
  name: "echo",
  description: "echoes",
  parameters: { type: "object" },
  execute: async (args) => `echo: ${(args as { text: string }).text}`,
};

function type(model: ConversationModel, text: string): void {
  for (const character of text) {
    model.handleKey(parseChord(character === " " ? "space" : character), character);
  }
}

function press(model: ConversationModel, key: string, transcriptRows = 10): boolean {
  return model.handleKey(parseChord(key), undefined, { transcriptRows, askRows: 8 });
}

function longConversation(): ConversationModel {
  const model = new ConversationModel(undefined, () => {});
  model.feed.entries.length = 0;
  for (let at = 1; at <= 20; at += 1) {
    model.feed.entries.push({ kind: "assistant", text: `line ${at}` });
  }
  return model;
}

describe("scrollback", () => {
  it("pages back through the transcript by the rows the pane reports and clamps at the top", () => {
    const model = longConversation();
    expect(model.visibleTranscript(80, 5).map((line) => line.text)).toEqual([
      "line 16",
      "line 17",
      "line 18",
      "line 19",
      "line 20",
    ]);

    press(model, "pageup", 5);
    expect(model.visibleTranscript(80, 5)[0]?.text).toBe("line 11");

    for (let at = 0; at < 10; at += 1) press(model, "pageup", 5);
    expect(model.visibleTranscript(80, 5)[0]?.text).toBe("line 1");
    press(model, "pagedown", 3);
    expect(model.visibleTranscript(80, 5)[0]?.text).toBe("line 4");
  });

  it("returns to live with escape", () => {
    const model = longConversation();
    model.visibleTranscript(80, 5);
    press(model, "pageup");
    expect(model.scrollBack).toBeGreaterThan(0);

    expect(press(model, "escape")).toBe(true);
    expect(model.scrollBack).toBe(0);
  });

  it("scrolls by wheel deltas through scrollBy", () => {
    const model = longConversation();
    model.visibleTranscript(80, 5);
    model.scrollBy(3);
    expect(model.visibleTranscript(80, 5)[0]?.text).toBe("line 13");
    model.scrollBy(-3);
    expect(model.visibleTranscript(80, 5)[0]?.text).toBe("line 16");
  });

  it("snaps to live when a prompt is sent", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
    const model = new ConversationModel(agent, () => {});
    for (let at = 1; at <= 20; at += 1) model.feed.entries.push({ kind: "info", text: `n ${at}` });
    model.visibleTranscript(80, 5);
    model.scrollBy(8);
    model.submitText("go");
    expect(model.scrollBack).toBe(0);
    await model.lastSend;
  });
});

describe("keyboard disclosure of older tool rows", () => {
  const twoTools = (): Agent =>
    new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "echo", arguments: { text: "one" } }),
        toolCallTurn({ type: "tool-call", callId: "c2", name: "echo", arguments: { text: "two" } }),
        textTurn("done"),
      ]),
      tools: [echoTool],
    });

  async function ranTwoTools(): Promise<ConversationModel> {
    const model = new ConversationModel(twoTools(), () => {});
    model.submitText("go");
    await model.lastSend;
    return model;
  }

  const toolLines = (model: ConversationModel) =>
    model.visibleTranscript(80, 40).filter((line) => line.kind === "tool");

  it("collapses a settled tool run and discloses detail under a rule on tab", async () => {
    const model = await ranTwoTools();
    expect(toolLines(model)).toHaveLength(2);
    expect(press(model, "tab")).toBe(true);
    const open = toolLines(model);
    expect(open.length).toBeGreaterThan(3);
    expect(open.at(-1)?.text).toBe("echo: two");
    expect(press(model, "tab")).toBe(true);
    expect(toolLines(model)).toHaveLength(2);
  });

  it("leaves tab alone while the prompt holds text", async () => {
    const model = await ranTwoTools();
    type(model, "draft");
    expect(press(model, "tab")).toBe(false);
    expect(toolLines(model)).toHaveLength(2);
  });

  it("walks the fold cursor to older rows with shift+tab and toggles them with tab", async () => {
    const model = await ranTwoTools();
    expect(model.disclosing()).toBe(false);

    expect(press(model, "shift+tab")).toBe(true);
    expect(model.disclosing()).toBe(true);
    expect(toolLines(model).at(-1)?.selected).toBe(true);

    expect(press(model, "shift+tab")).toBe(true);
    const lines = toolLines(model);
    expect(lines[0]?.selected).toBe(true);
    expect(lines[1]?.selected).toBeUndefined();

    expect(press(model, "tab")).toBe(true);
    const open = toolLines(model);
    expect(open[0]?.selected).toBe(true);
    expect(open[1]?.spans?.[0]?.tone).toBe("rule");
    expect(open[1]?.selected).toBeUndefined();
    expect(open.some((line) => line.text === "echo: one")).toBe(true);
    expect(open.some((line) => line.text === "echo: two")).toBe(false);
  });

  it("wraps from the oldest row back to the newest", async () => {
    const model = await ranTwoTools();
    press(model, "shift+tab");
    press(model, "shift+tab");
    press(model, "shift+tab");
    expect(toolLines(model).at(-1)?.selected).toBe(true);
  });

  it("leaves disclosure on escape or typing, keeping the rows as they were", async () => {
    const model = await ranTwoTools();
    press(model, "shift+tab");
    press(model, "tab");
    expect(press(model, "escape")).toBe(true);
    expect(model.disclosing()).toBe(false);
    expect(toolLines(model).some((line) => line.text === "echo: two")).toBe(true);
    expect(toolLines(model).every((line) => line.selected === undefined)).toBe(true);

    press(model, "shift+tab");
    type(model, "x");
    expect(model.disclosing()).toBe(false);
    expect(model.input).toBe("x");
  });

  it("does nothing when no row can be disclosed", () => {
    const model = new ConversationModel(undefined, () => {});
    expect(press(model, "shift+tab")).toBe(false);
    expect(model.disclosing()).toBe(false);
  });

  it("scrolls the cursored row into view and returns to live on escape", async () => {
    const model = await ranTwoTools();
    press(model, "shift+tab");
    press(model, "shift+tab");
    const visible = model.visibleTranscript(80, 2);
    expect(visible.some((line) => line.selected === true)).toBe(true);
    expect(model.scrollBack).toBeGreaterThan(0);
    press(model, "escape");
    expect(model.scrollBack).toBe(0);
  });
});

describe("backtrack selection", () => {
  async function conversed(...prompts: string[]): Promise<ConversationModel> {
    const agent = new Agent({
      provider: new MockProvider(prompts.map((prompt) => textTurn(`re: ${prompt}`))),
    });
    const model = new ConversationModel(agent, () => {});
    for (const prompt of prompts) {
      model.submitText(prompt);
      await model.lastSend;
    }
    return model;
  }

  it("arms on esc-esc, walks older with up, and highlights the selected prompt", async () => {
    const model = await conversed("one", "two", "three");
    press(model, "escape");
    expect(model.backtracking()).toBe(false);
    press(model, "escape");
    expect(model.backtracking()).toBe(true);
    const selected = () =>
      model.visibleTranscript(80, 20).find((line) => line.selected === true)?.text;
    expect(selected()).toBe("three");
    press(model, "up");
    expect(selected()).toBe("two");
    press(model, "up");
    press(model, "up");
    expect(selected()).toBe("one");
    press(model, "down");
    expect(selected()).toBe("two");
  });

  it("leaves backtrack when stepping below the newest prompt, on escape, or on any other key", async () => {
    const model = await conversed("one");
    press(model, "escape");
    press(model, "escape");
    press(model, "down");
    expect(model.backtracking()).toBe(false);

    press(model, "escape");
    press(model, "escape");
    press(model, "escape");
    expect(model.backtracking()).toBe(false);

    press(model, "escape");
    press(model, "escape");
    type(model, "x");
    expect(model.backtracking()).toBe(false);
    expect(model.input).toBe("x");
  });

  it("does not arm while the prompt holds text, and the escape prime expires on any key", async () => {
    const model = await conversed("one");
    type(model, "draft");
    expect(press(model, "escape")).toBe(false);
    press(model, "escape");
    expect(model.backtracking()).toBe(false);
    press(model, "backspace");
    press(model, "backspace");
    press(model, "backspace");
    press(model, "backspace");
    press(model, "backspace");
    press(model, "escape");
    type(model, "y");
    press(model, "backspace");
    press(model, "escape");
    expect(model.backtracking()).toBe(false);
  });
});

describe("TranscriptNavigation viewport", () => {
  it("hands the view only the state that is set and adopts the frame's clamp", () => {
    const feed = new TranscriptFeed(() => {});
    feed.entries.push({ kind: "user", text: "a" }, { kind: "user", text: "b" });
    const navigation = new TranscriptNavigation(feed, () => {});
    expect(navigation.viewport()).toEqual({ scrollBack: 0 });
    navigation.scrollBy(5);
    navigation.enterBacktrack();
    expect(navigation.viewport()).toEqual({ scrollBack: 5, revealAt: 1, backtrackAt: 1 });
    navigation.framed(3, 40);
    expect(navigation.viewport()).toEqual({ scrollBack: 3, anchorTotal: 40, backtrackAt: 1 });
    expect(navigation.selectedPrompt()).toEqual({ kind: "user", text: "b" });
    navigation.reset();
    expect(navigation.viewport()).toEqual({ scrollBack: 3 });
  });
});
