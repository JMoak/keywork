import { Agent, MockProvider, type Tool, textTurn, toolCallTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationModel, transcriptLines } from "./conversation-model.ts";
import { parseChord } from "./keys.ts";

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

function submit(model: ConversationModel): Promise<unknown> {
  model.handleKey(parseChord("return"), undefined);
  return model.lastSend;
}

describe("ConversationModel", () => {
  it("collects typed input and clears it on submit", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("hey")]) });
    const model = new ConversationModel(agent, () => {});

    type(model, "hi there");
    expect(model.input).toBe("hi there");
    await submit(model);

    expect(model.input).toBe("");
    expect(model.entries).toEqual([
      { kind: "user", text: "hi there" },
      { kind: "assistant", text: "hey" },
    ]);
    expect(model.busy).toBe(false);
  });

  it("supports backspace while composing", () => {
    const model = new ConversationModel(undefined, () => {});
    type(model, "abc");
    model.handleKey(parseChord("backspace"), undefined);
    expect(model.input).toBe("ab");
  });

  it("streams assistant text into one growing entry", async () => {
    const agent = new Agent({
      provider: new MockProvider([
        [
          { type: "text", text: "one " },
          { type: "text", text: "two" },
          { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
      ]),
    });
    const model = new ConversationModel(agent, () => {});

    type(model, "go");
    await submit(model);

    expect(model.entries.at(-1)).toEqual({ kind: "assistant", text: "one two" });
  });

  it("records tool calls and their outcomes", async () => {
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: "echo", arguments: { text: "hi" } }),
        textTurn("done"),
      ]),
      tools: [echoTool],
    });
    const model = new ConversationModel(agent, () => {});

    type(model, "use echo");
    await submit(model);

    const kinds = model.entries.map((entry) => entry.kind);
    expect(kinds).toEqual(["user", "tool", "tool", "assistant"]);
    expect(model.entries[2]).toMatchObject({ text: "✓ echo: hi", failed: false });
  });

  it("surfaces provider failures as error entries instead of throwing", async () => {
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
    const agent = new Agent({ provider: failing });
    const model = new ConversationModel(agent, () => {});

    type(model, "hello");
    await submit(model);

    expect(model.entries.at(-1)).toEqual({ kind: "error", text: "provider down" });
    expect(model.busy).toBe(false);
  });

  it("explains itself when no provider is configured", () => {
    const model = new ConversationModel(undefined, () => {});
    expect(model.entries[0]?.kind).toBe("info");
    type(model, "hi");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries).toHaveLength(1);
  });

  it("does not treat control chords as text", () => {
    const model = new ConversationModel(undefined, () => {});
    model.handleKey(parseChord("ctrl+s"), "s");
    expect(model.input).toBe("");
  });
});

describe("slash commands", () => {
  const commandNames = ["exit", "exit-all", "move-right"];
  function modelWithCommands(onRun: (name: string) => void = () => {}): ConversationModel {
    return new ConversationModel(undefined, () => {}, undefined, {
      search: (query) =>
        commandNames
          .filter((name) => name.startsWith(query.toLowerCase()))
          .map((name) => ({ name, description: name })),
      run: (name) => {
        if (!commandNames.includes(name)) return false;
        onRun(name);
        return true;
      },
    });
  }

  it("suggests matching commands while typing a slash query", () => {
    const model = modelWithCommands();
    type(model, "/ex");
    expect(model.suggestions().map((suggestion) => suggestion.name)).toEqual(["exit", "exit-all"]);
  });

  it("runs the exact command on enter and clears the input", () => {
    const ran: string[] = [];
    const model = modelWithCommands((name) => ran.push(name));
    type(model, "/exit");
    model.handleKey(parseChord("return"), undefined);
    expect(ran).toEqual(["exit"]);
    expect(model.input).toBe("");
  });

  it("falls back to the selected suggestion for partial input", () => {
    const ran: string[] = [];
    const model = modelWithCommands((name) => ran.push(name));
    type(model, "/ex");
    model.handleKey(parseChord("down"), undefined);
    model.handleKey(parseChord("return"), undefined);
    expect(ran).toEqual(["exit-all"]);
  });

  it("completes the selection with tab", () => {
    const model = modelWithCommands();
    type(model, "/mo");
    model.handleKey(parseChord("tab"), undefined);
    expect(model.input).toBe("/move-right");
  });

  it("reports unknown commands as an error entry", () => {
    const model = modelWithCommands();
    type(model, "/nonsense");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries.at(-1)).toMatchObject({ kind: "error" });
  });

  it("clears slash input with escape", () => {
    const model = modelWithCommands();
    type(model, "/ex");
    model.handleKey(parseChord("escape"), undefined);
    expect(model.input).toBe("");
  });

  it("works without any agent so commands function providerless", () => {
    const ran: string[] = [];
    const model = modelWithCommands((name) => ran.push(name));
    type(model, "/move-right");
    model.handleKey(parseChord("return"), undefined);
    expect(ran).toEqual(["move-right"]);
  });
});

describe("auto-titling", () => {
  it("requests a title once after the first completed turn", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("a"), textTurn("b")]) });
    let calls = 0;
    const model = new ConversationModel(
      agent,
      () => {},
      async () => {
        calls += 1;
        return "fix-auth-tests";
      },
    );

    type(model, "one");
    await submit(model);
    await model.lastTitle;
    type(model, "two");
    await submit(model);
    await model.lastTitle;

    expect(model.title).toBe("fix-auth-tests");
    expect(calls).toBe(1);
  });

  it("keeps the pane untitled when the titler fails", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("a")]) });
    const model = new ConversationModel(
      agent,
      () => {},
      async () => {
        throw new Error("nope");
      },
    );

    type(model, "one");
    await submit(model);
    await model.lastTitle;

    expect(model.title).toBeUndefined();
  });
});

describe("transcriptLines", () => {
  it("prefixes user entries and wraps long lines to width", () => {
    const lines = transcriptLines(
      [
        { kind: "user", text: "abcdefgh" },
        { kind: "assistant", text: "12345" },
      ],
      5,
    );
    expect(lines.map((line) => line.text)).toEqual(["› abc", "defgh", "12345"]);
  });

  it("splits embedded newlines", () => {
    const lines = transcriptLines([{ kind: "assistant", text: "a\nb" }], 10);
    expect(lines.map((line) => line.text)).toEqual(["a", "b"]);
  });
});
