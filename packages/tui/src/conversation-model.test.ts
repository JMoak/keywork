import {
  Agent,
  EventBus,
  MockProvider,
  type Provider,
  type Tool,
  type ToolCallPart,
  type TurnDelta,
  textMessage,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationModel } from "./conversation-model.ts";
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

async function drained(model: ConversationModel): Promise<void> {
  let previous: Promise<unknown>;
  do {
    previous = model.lastSend;
    await previous;
  } while (previous !== model.lastSend);
}

function gate(): { open: () => void; opened: Promise<void> } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function gatedProvider(opened: Promise<void>, replies: string[]): Provider {
  let turn = 0;
  return {
    name: "gated",
    async *stream(request): AsyncGenerator<TurnDelta> {
      const reply = replies[turn] ?? "";
      turn += 1;
      if (turn === 1) {
        await Promise.race([opened, abortOf(request.signal)]);
        if (request.signal?.aborted) throw new Error("aborted");
      }
      yield* textTurn(reply);
    },
  };
}

function abortOf(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
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
    const model = new ConversationModel(new Agent({ provider: failing }), () => {});

    type(model, "hello");
    await submit(model);

    expect(model.entries.at(-1)).toEqual({ kind: "error", text: "provider down" });
    expect(model.busy).toBe(false);
  });

  it("renders a non-Error after-turn rejection as its stringified cause", async () => {
    const model = new ConversationModel(
      new Agent({ provider: new MockProvider([textTurn("a")]) }),
      () => {},
    );
    model.bindAfterTurn(() => Promise.reject("plain string"));
    type(model, "go");
    await submit(model);
    expect(model.entries.at(-1)).toEqual({ kind: "error", text: "plain string" });
  });

  it("explains itself when no provider is configured and keeps the draft", () => {
    const model = new ConversationModel(undefined, () => {});
    expect(model.entries[0]?.kind).toBe("info");
    type(model, "hi");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries).toHaveLength(1);
    expect(model.input).toBe("hi");
  });

  it("does not treat control chords as text", () => {
    const model = new ConversationModel(undefined, () => {});
    model.handleKey(parseChord("ctrl+s"), "s");
    expect(model.input).toBe("");
  });

  it("ignores pastes while an ask is pending", () => {
    const model = new ConversationModel(undefined, () => {});
    void model.confirmMutation({ type: "tool-call", callId: "c", name: "write", arguments: {} });
    expect(model.paste("sneaky")).toBe(true);
    expect(model.input).toBe("");
    expect(model.pendingAsk).toBeDefined();
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

  it("reports unknown commands as an error entry", () => {
    const model = modelWithCommands();
    type(model, "/nonsense");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries.at(-1)).toEqual({ kind: "error", text: "unknown command /nonsense" });
  });

  it("works without any agent so commands function providerless", () => {
    const ran: string[] = [];
    const model = modelWithCommands((name) => ran.push(name));
    type(model, "/move-right");
    model.handleKey(parseChord("return"), undefined);
    expect(ran).toEqual(["move-right"]);
  });

  it("/compact without a model or a hook says so", () => {
    const idle = new ConversationModel(undefined, () => {});
    type(idle, "/compact");
    idle.handleKey(parseChord("return"), undefined);
    expect(idle.entries.at(-1)).toEqual({
      kind: "info",
      text: "no model bound · nothing to compact",
    });

    const unbound = new ConversationModel(new Agent({ provider: new MockProvider([]) }), () => {});
    type(unbound, "/compact");
    unbound.handleKey(parseChord("return"), undefined);
    expect(unbound.entries.at(-1)).toEqual({
      kind: "info",
      text: "can't compact · no session store",
    });
  });

  it("/compact occupies the pane while the hook runs and passes the focus text through", async () => {
    const model = new ConversationModel(new Agent({ provider: new MockProvider([]) }), () => {});
    const asked: string[] = [];
    const { open, opened } = gate();
    model.bindCompaction(async (instructions) => {
      asked.push(instructions);
      await opened;
    });
    type(model, "/compact keep the file names");
    model.handleKey(parseChord("return"), undefined);
    expect(asked).toEqual(["keep the file names"]);
    expect(model.busy).toBe(true);
    open();
    await model.lastSend;
    expect(model.busy).toBe(false);
  });
});

describe("/thinking", () => {
  it("toggles the agent's request flag, records the switch through the hook, and says what changed", async () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const model = new ConversationModel(agent, () => {});
    const recorded: string[] = [];
    model.bindThinkingChange(async (level) => {
      recorded.push(level);
    });

    type(model, "/thinking");
    model.handleKey(parseChord("return"), undefined);
    await model.lastSend;
    expect(agent.thinking()).toBe(true);
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: "thinking shown · tab unfolds it · /thinking hides it again",
    });

    type(model, "/thinking");
    model.handleKey(parseChord("return"), undefined);
    await model.lastSend;
    expect(agent.thinking()).toBe(false);
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: "thinking hidden · requests go out as before",
    });

    type(model, "/thinking on");
    model.handleKey(parseChord("return"), undefined);
    await model.lastSend;
    expect(agent.thinking()).toBe(true);
    expect(recorded).toEqual(["on", "off", "on"]);
  });

  it("says so without a model and offers the command in the tray", () => {
    const idle = new ConversationModel(undefined, () => {});
    type(idle, "/thinking");
    idle.handleKey(parseChord("return"), undefined);
    expect(idle.entries.at(-1)).toEqual({
      kind: "info",
      text: "no model bound · nothing to think with",
    });
    type(idle, "/think");
    expect(idle.suggestions().map((suggestion) => suggestion.name)).toContain("thinking");
  });

  it("carries the switch onto a swapped-in agent", () => {
    const first = new Agent({ provider: new MockProvider([]), thinking: true });
    const model = new ConversationModel(first, () => {});
    const second = new Agent({ provider: new MockProvider([]), bus: new EventBus() });
    model.swapAgent(second);
    expect(second.thinking()).toBe(true);
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

  it("an adopted title shows immediately and silences the titler", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("a")]) });
    let calls = 0;
    let notified = 0;
    const model = new ConversationModel(
      agent,
      () => {
        notified += 1;
      },
      async () => {
        calls += 1;
        return "llm-title";
      },
    );

    model.adoptTitle("stored-title");
    expect(model.title).toBe("stored-title");
    expect(notified).toBeGreaterThan(0);

    type(model, "one");
    await submit(model);
    await model.lastTitle;

    expect(model.title).toBe("stored-title");
    expect(calls).toBe(0);
  });

  it("does not request a title for replayed turns", async () => {
    let titled = 0;
    const agent = new Agent({ provider: new MockProvider([textTurn("live reply")]) });
    const model = new ConversationModel(
      agent,
      () => {},
      async () => {
        titled += 1;
        return "a title";
      },
    );

    agent.bus.emit("turn.completed", {
      message: textMessage("assistant", "revived reply"),
      usage: { inputTokens: 0, outputTokens: 0 },
      replay: true,
    });
    await model.lastTitle;
    expect(titled).toBe(0);

    model.submitText("go");
    await model.lastSend;
    await model.lastTitle;
    expect(titled).toBe(1);
  });
});

describe("the engine-owned turn queue", () => {
  it("queues a second prompt mid-turn through the agent and sends it after the first completes", async () => {
    const { open, opened } = gate();
    const agent = new Agent({ provider: gatedProvider(opened, ["first reply", "second reply"]) });
    const model = new ConversationModel(agent, () => {});

    type(model, "first");
    model.handleKey(parseChord("return"), undefined);
    expect(model.busy).toBe(true);
    type(model, "second");
    model.handleKey(parseChord("return"), undefined);
    expect(model.queued()).toEqual(["second"]);
    expect(agent.queued().map((prompt) => prompt.text)).toEqual(["second"]);
    expect(model.entries.map((entry) => entry.kind)).toEqual(["user"]);

    open();
    await drained(model);

    expect(model.entries).toEqual([
      { kind: "user", text: "first" },
      { kind: "assistant", text: "first reply" },
      { kind: "user", text: "second" },
      { kind: "assistant", text: "second reply" },
    ]);
    expect(model.busy).toBe(false);
    expect(model.queued()).toEqual([]);
  });

  it("keeps the transcript in true send order with several prompts queued", async () => {
    const { open, opened } = gate();
    const agent = new Agent({ provider: gatedProvider(opened, ["re: a", "re: b", "re: c"]) });
    const model = new ConversationModel(agent, () => {});

    for (const prompt of ["a", "b", "c"]) {
      type(model, prompt);
      model.handleKey(parseChord("return"), undefined);
    }
    expect(model.queued()).toEqual(["b", "c"]);

    open();
    await drained(model);

    expect(model.entries.map((entry) => entry.text)).toEqual([
      "a",
      "re: a",
      "b",
      "re: b",
      "c",
      "re: c",
    ]);
  });

  it("steers through the engine when asked: the running turn is interrupted first", async () => {
    const { opened } = gate();
    const agent = new Agent({ provider: gatedProvider(opened, ["never", "steered reply"]) });
    const model = new ConversationModel(agent, () => {});

    model.submitText("slow one");
    model.submitText("actually this", "steer");
    await drained(model);

    expect(model.entries.map((entry) => entry.text)).toEqual([
      "slow one",
      "· interrupted",
      "actually this",
      "steered reply",
    ]);
  });

  it("runs the after-turn hook after every turn, before the next queued prompt starts", async () => {
    const { open, opened } = gate();
    const agent = new Agent({ provider: gatedProvider(opened, ["re: a", "re: b"]) });
    const model = new ConversationModel(agent, () => {});
    const seen: number[] = [];
    model.bindAfterTurn(async () => {
      seen.push(agent.history().length);
    });
    model.submitText("a");
    model.submitText("b");
    open();
    await drained(model);
    expect(seen).toEqual([2, 4]);
  });

  it("queues a prompt typed while the after-turn hook settles in the engine, never in the model", async () => {
    const { open, opened } = gate();
    const agent = new Agent({
      provider: new MockProvider([textTurn("re: one"), textTurn("re: held")]),
    });
    const model = new ConversationModel(agent, () => {});
    const hook = gate();
    model.bindAfterTurn(() => {
      hook.open();
      return opened;
    });
    model.submitText("one");
    await hook.opened;
    expect(agent.busy()).toBe(true);
    expect(model.busy).toBe(true);

    model.submitText("held");
    expect(agent.queued().map((prompt) => prompt.text)).toEqual(["held"]);
    expect(model.queued()).toEqual(["held"]);
    expect(agent.history()).toHaveLength(2);

    open();
    await drained(model);
    expect(model.entries.map((entry) => entry.text)).toEqual([
      "one",
      "re: one",
      "held",
      "re: held",
    ]);
    expect(model.queued()).toEqual([]);
  });

  it("a failing after-turn hook is reported and the queued prompt still runs", async () => {
    const agent = new Agent({
      provider: new MockProvider([textTurn("re: one"), textTurn("re: two")]),
    });
    const model = new ConversationModel(agent, () => {});
    let settles = 0;
    model.bindAfterTurn(async () => {
      settles += 1;
      if (settles === 1) throw new Error("journal write failed");
    });
    model.submitText("one");
    model.submitText("two");
    await drained(model);
    expect(model.entries.map((entry) => `${entry.kind}:${entry.text}`)).toEqual([
      "user:one",
      "assistant:re: one",
      "error:journal write failed",
      "user:two",
      "assistant:re: two",
    ]);
    expect(settles).toBe(2);
  });

  it("swapping agents mid-settlement carries the queued prompts to the new agent", async () => {
    const { open, opened } = gate();
    const stale = new Agent({ provider: gatedProvider(opened, ["re: one"]) });
    const fresh = new Agent({ provider: new MockProvider([textTurn("re: two")]) });
    const model = new ConversationModel(stale, () => {});
    model.bindAfterTurn(async () => {
      model.swapAgent(fresh);
    });
    model.submitText("one");
    model.submitText("two");
    open();
    await drained(model);
    expect(model.currentAgent()).toBe(fresh);
    expect(stale.history().map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(fresh.history().map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(model.entries.map((entry) => entry.text)).toEqual(["one", "re: one", "two", "re: two"]);
  });

  it("alt+enter steers and plain enter queues", async () => {
    const { opened } = gate();
    const agent = new Agent({ provider: gatedProvider(opened, ["never", "steered"]) });
    const model = new ConversationModel(agent, () => {});
    model.submitText("slow one");
    type(model, "queued");
    model.handleKey(parseChord("return"), undefined);
    expect(agent.queued().map((prompt) => prompt.behavior)).toEqual(["queue"]);
    type(model, "now");
    model.handleKey(parseChord("alt+return"), undefined);
    expect(agent.queued().map((prompt) => `${prompt.behavior}:${prompt.text}`)).toEqual([
      "steer:now",
      "queue:queued",
    ]);
    await drained(model);
    expect(model.entries.map((entry) => entry.text)).toEqual([
      "slow one",
      "· interrupted",
      "now",
      "steered",
      "queued",
      "",
    ]);
  });

  it("dispose mid-turn interrupts the agent and silences every bus listener", async () => {
    const agent = new Agent({
      provider: new MockProvider([
        [
          { type: "text", text: "streaming " },
          { type: "text", text: "along" },
          { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
      ]),
    });
    let notifies = 0;
    const model = new ConversationModel(agent, () => {
      notifies += 1;
    });
    let interrupted = false;
    agent.bus.on("turn.interrupted", () => {
      interrupted = true;
    });

    type(model, "go");
    model.handleKey(parseChord("return"), undefined);
    model.dispose();
    const notifiesAtDispose = notifies;
    await model.lastSend;

    expect(interrupted).toBe(true);
    expect(agent.busy()).toBe(false);
    expect(model.busy).toBe(false);
    expect(notifies).toBe(notifiesAtDispose);
    expect(model.entries).toEqual([{ kind: "user", text: "go" }]);
  });

  it("cancels queued prompts in the engine on dispose instead of sending them to a dead pane", async () => {
    const { open, opened } = gate();
    const agent = new Agent({ provider: gatedProvider(opened, ["first reply", "never sent"]) });
    const model = new ConversationModel(agent, () => {});

    model.submitText("first");
    model.submitText("second");
    expect(agent.queued()).toHaveLength(1);

    model.dispose();
    open();
    await drained(model);

    expect(agent.queued()).toEqual([]);
    expect(model.queued()).toEqual([]);
    expect(agent.history().filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("escape snaps to live before it interrupts a running turn", async () => {
    const { open, opened } = gate();
    const agent = new Agent({
      provider: gatedProvider(opened, [Array.from({ length: 20 }, () => "line").join("\n")]),
    });
    const model = new ConversationModel(agent, () => {});
    model.submitText("go");
    model.visibleTranscript(80, 5);
    model.handleKey(parseChord("pageup"), undefined);
    expect(model.scrollBack).toBeGreaterThan(0);

    model.handleKey(parseChord("escape"), undefined);
    expect(model.scrollBack).toBe(0);
    expect(model.busy).toBe(true);

    model.handleKey(parseChord("escape"), undefined);
    open();
    await drained(model);
    expect(model.busy).toBe(false);
    expect(model.entries.some((entry) => entry.text === "· interrupted")).toBe(true);
  });
});

describe("settlement events", () => {
  it("tells its listener how the turn ended once the pane goes idle", async () => {
    const outcomes: string[] = [];
    const agent = new Agent({ provider: new MockProvider([textTurn("fine")]) });
    const model = new ConversationModel(agent, () => {});
    model.onSettled((outcome) => outcomes.push(outcome));
    model.submitText("go");
    expect(outcomes).toEqual([]);
    await drained(model);
    expect(outcomes).toEqual(["finished"]);
  });

  it("reports a failed settlement when the last entry is an error", async () => {
    const outcomes: string[] = [];
    const model = new ConversationModel(
      new Agent({ provider: new MockProvider([textTurn("a")]) }),
      () => {},
    );
    model.onSettled((outcome) => outcomes.push(outcome));
    model.bindAfterTurn(async () => {
      throw new Error("flush broke");
    });
    model.submitText("go");
    await drained(model);
    expect(outcomes).toEqual(["failed"]);
  });
});

describe("disposal", () => {
  it("drops fork and title results that land after dispose", async () => {
    let releaseFork: (outcome: { forked: boolean }) => void = () => {};
    let releaseTitle: (title: string | undefined) => void = () => {};
    const agent = new Agent({ provider: new MockProvider([textTurn("re: one")]) });
    let notified = 0;
    const model = new ConversationModel(
      agent,
      () => {
        notified += 1;
      },
      () =>
        new Promise((resolve) => {
          releaseTitle = resolve;
        }),
      undefined,
      {
        forkAtPrompt: () =>
          new Promise((resolve) => {
            releaseFork = resolve;
          }),
      },
    );
    type(model, "one");
    await submit(model);
    model.adoptPromptId("p1");
    model.handleKey(parseChord("escape"), undefined);
    model.handleKey(parseChord("escape"), undefined);
    model.handleKey(parseChord("return"), undefined);
    const entriesBefore = model.entries.length;
    model.dispose();
    const notifiedBefore = notified;
    releaseFork({ forked: false });
    releaseTitle("late-title");
    await model.lastFork;
    await model.lastTitle;
    expect(model.entries.length).toBe(entriesBefore);
    expect(model.title).toBeUndefined();
    expect(notified).toBe(notifiedBefore);
  });

  it("still runs the after-turn hook for a turn in flight at dispose", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("a")]) });
    let hooked = 0;
    const model = new ConversationModel(agent, () => {});
    model.bindAfterTurn(async () => {
      hooked += 1;
    });
    type(model, "one");
    const send = submit(model);
    model.dispose();
    await send;
    expect(hooked).toBe(1);
  });

  it("ignores submitted text once disposed", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("hey")]) });
    const model = new ConversationModel(agent, () => {});
    model.dispose();
    model.submitText("go");
    await model.lastSend;
    expect(model.entries).toEqual([]);
    expect(agent.history()).toEqual([]);
  });
});

describe("swapping agents", () => {
  it("follows the new agent's bus even when it is a fresh one", async () => {
    const first = new Agent({ provider: new MockProvider([textTurn("a")]) });
    const model = new ConversationModel(first, () => {});
    model.submitText("one");
    await model.lastSend;

    const second = new Agent({
      provider: new MockProvider([textTurn("b")]),
      bus: new EventBus(),
      history: first.history(),
    });
    model.swapAgent(second);
    model.submitText("two");
    await model.lastSend;

    expect(model.entries.map((entry) => entry.text)).toEqual(["one", "a", "two", "b"]);
    first.bus.emit("turn.delta", { delta: { type: "text", text: "ghost" } });
    expect(model.entries.at(-1)).toEqual({ kind: "assistant", text: "b" });
  });

  it("denies an ask left pending by the agent being swapped out", async () => {
    const model = new ConversationModel(new Agent({ provider: new MockProvider([]) }), () => {});
    const call: ToolCallPart = { type: "tool-call", callId: "c1", name: "write", arguments: {} };
    const verdict = model.confirmMutation(call);
    model.swapAgent(new Agent({ provider: new MockProvider([]) }));
    expect(await verdict).toBe(false);
    expect(model.pendingAsk).toBeUndefined();
  });

  it("carries cost and tokens across agent swaps and attributes them per model", async () => {
    const first = new Agent({
      provider: new MockProvider([textTurn("a", { inputTokens: 10_000, outputTokens: 1_000 })], {
        modelId: "gpt-5-mini",
      }),
    });
    const model = new ConversationModel(first, () => {});
    type(model, "one");
    await submit(model);
    expect(model.usageSummary()).toBe("$0.0045");

    const second = new Agent({
      provider: new MockProvider([textTurn("b", { inputTokens: 2_000, outputTokens: 100 })], {
        modelId: "gpt-5",
      }),
      bus: first.bus,
      history: first.history(),
    });
    model.swapAgent(second);
    expect(model.usageSummary()).toBe("$0.0045");
    type(model, "two");
    await submit(model);
    expect(model.usageSummary()).toBe("$0.008");

    type(model, "/cost");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: [
        "tokens 12000▸1100",
        "cost $0.008 · estimated from gpt-5 rates",
        "  mock/gpt-5-mini · 1 turn · 10000▸1000 · $0.0045",
        "  mock/gpt-5 · 1 turn · 2000▸100 · $0.0035",
      ].join("\n"),
    });
  });

  it("adds the bound bot's spend across sessions to /cost when a spend port answers", async () => {
    const agent = new Agent({
      provider: new MockProvider([textTurn("a", { inputTokens: 10_000, outputTokens: 1_000 })], {
        modelId: "gpt-5-mini",
      }),
    });
    const asked: string[] = [];
    const model = new ConversationModel(agent, () => {}, undefined, undefined, {
      botSpend: async (bot) => {
        asked.push(bot);
        return {
          name: bot,
          sigil: "⚖",
          source: "project",
          sessions: 3,
          costNanos: 12_300_000,
        };
      },
    });
    model.ledger.bot = "reviewer";
    type(model, "one");
    await submit(model);
    type(model, "/cost");
    model.handleKey(parseChord("return"), undefined);
    await drained(model);
    expect(asked).toEqual(["reviewer"]);
    expect(model.entries.at(-1)?.text).toBe(
      [
        "tokens 10000▸1000",
        "cost $0.0045 · estimated from gpt-5-mini rates",
        "bot ⚖ reviewer · $0.0123 across 3 sessions",
      ].join("\n"),
    );
  });
});

describe("forking by prompt identity", () => {
  it("forks the selected prompt by its session entry id", async () => {
    const forks: { promptId: string; draft: string }[] = [];
    const agent = new Agent({ provider: new MockProvider([textTurn("re: new")]) });
    const model = new ConversationModel(agent, () => {}, undefined, undefined, {
      forkAtPrompt: async (promptId, draft) => {
        forks.push({ promptId, draft });
        return { forked: true, note: "files put back" };
      },
    });
    agent.bus.emit("turn.started", { userText: "old prompt", replay: true, entryId: "u-old" });
    model.submitText("new prompt");
    await model.lastSend;

    for (const key of ["escape", "escape", "up", "return"]) {
      model.handleKey(parseChord(key), undefined);
    }
    await model.lastFork;
    expect(forks).toEqual([{ promptId: "u-old", draft: "old prompt" }]);
    expect(model.entries.at(-1)).toEqual({ kind: "info", text: "files put back" });
  });

  it("explains when a prompt has no fork point or no store", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("a")]) });
    const model = new ConversationModel(agent, () => {});
    model.submitText("one");
    await model.lastSend;
    for (const key of ["escape", "escape", "return"]) model.handleKey(parseChord(key), undefined);
    expect(model.entries.at(-1)).toEqual({ kind: "info", text: "can't fork · no session store" });
  });

  it("refuses to fork while a turn is running", async () => {
    const { open, opened } = gate();
    const agent = new Agent({ provider: gatedProvider(opened, ["a"]) });
    const model = new ConversationModel(agent, () => {}, undefined, undefined, {
      forkAtPrompt: async () => ({ forked: true }),
    });
    model.submitText("one");
    agent.bus.emit("turn.started", { userText: "old", replay: true, entryId: "u-old" });
    for (const key of ["escape", "escape"]) model.handleKey(parseChord(key), undefined);
    expect(model.backtracking()).toBe(false);
    open();
    await drained(model);
  });
});

describe("tool rows through the model", () => {
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
    expect(kinds).toEqual(["user", "tool", "assistant"]);
    expect(model.entries[1]).toMatchObject({ failed: false });
    expect(model.entries[1]?.text).toMatch(/^echo hi · \d+(\.\d+)?(ms|s|m) · done$/);
    expect(model.entries[1]).toMatchObject({
      run: { detail: ["echo: hi"], folded: true },
    });
  });
});

describe("suggestion tray pointer", () => {
  function trayModel(onRun: (name: string) => void) {
    const names = ["exit", "exit-all"];
    return new ConversationModel(undefined, () => {}, undefined, {
      search: (query) =>
        names
          .filter((name) => name.startsWith(query.toLowerCase()))
          .map((name) => ({ name, description: name })),
      run: (name) => {
        if (!names.includes(name)) return false;
        onRun(name);
        return true;
      },
    });
  }

  it("hover selects a row and click accepts it, one path with enter", () => {
    const ran: string[] = [];
    const model = trayModel((name) => ran.push(name));
    type(model, "/ex");
    model.traySelect(1);
    expect(model.selectedSuggestion).toBe(1);
    expect(model.trayAccept(1)).toBe(true);
    expect(ran).toEqual(["exit-all"]);
    expect(model.input).toBe("");
  });

  it("stays inert without a slash query", () => {
    const model = trayModel(() => {});
    expect(model.trayAccept(0)).toBe(false);
    model.traySelect(2);
    expect(model.selectedSuggestion).toBe(0);
  });
});

describe("/policy", () => {
  function modelBoundTo(bot: string | undefined, learning?: "off" | "notes" | "skills" | "self") {
    const agent = new Agent({ provider: new MockProvider([textTurn("a")]) });
    const model = new ConversationModel(agent, () => {}, undefined, undefined, {
      botOf: (name) => ({
        name,
        sigil: "⚖",
        source: "project",
        ...(learning !== undefined && { learning }),
      }),
    });
    model.ledger.bot = bot;
    return model;
  }

  it("prints the bound bot's learning level with every level explained and the current one marked", () => {
    const model = modelBoundTo("reviewer", "notes");
    type(model, "/policy");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: [
        "learning · ⚖ reviewer · notes",
        "  off    remembers nothing, a stateless role",
        "▸ notes  remembers craft in its own layer, proposes notes to the inbox under its sigil",
        "  skills not built yet, runs as notes: routines kept in the bot's own skills dir",
        "  self   not built yet, runs as notes: proposals against its own bot.md through the inbox",
      ].join("\n"),
    });
  });

  it("marks a skills or self bot as not built yet rather than as notes", () => {
    const model = modelBoundTo("reviewer", "self");
    type(model, "/policy");
    model.handleKey(parseChord("return"), undefined);
    const text = model.entries.at(-1)?.text ?? "";
    expect(text.startsWith("learning · ⚖ reviewer · self\n")).toBe(true);
    expect(text).toContain("▸ self   not built yet, runs as notes");
    expect(text).toContain("  notes  remembers craft");
  });

  it("leaves an unbound pane byte-identical: /policy is still an unknown command", () => {
    const model = modelBoundTo(undefined, "notes");
    type(model, "/policy");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries.at(-1)).toEqual({ kind: "error", text: "unknown command /policy" });
  });
});
