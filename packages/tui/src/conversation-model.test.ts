import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  MockProvider,
  replaySession,
  SessionStore,
  type Tool,
  type ToolCallPart,
  textMessage,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationModel, type TranscriptEntry, transcriptLines } from "./conversation-model.ts";
import { parseChord } from "./keys.ts";
import { resolvePage } from "./page.ts";

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
    expect(kinds).toEqual(["user", "tool", "assistant"]);
    expect(model.entries[1]).toMatchObject({ failed: false });
    expect(model.entries[1]?.text).toMatch(/^echo hi · \d+(\.\d+)?(ms|s|m) · done$/);
    expect(model.entries[1]).toMatchObject({
      run: { detail: ["echo: hi"], folded: true },
    });
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

  it("auto-denies mutation confirmations once disposed", async () => {
    const model = new ConversationModel(undefined, () => {});
    model.dispose();
    const call: ToolCallPart = { type: "tool-call", callId: "c1", name: "bash", arguments: {} };
    await expect(model.confirmMutation(call)).resolves.toBe(false);
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

describe("multiline input", () => {
  it("keeps composing across shift+enter and submits the whole message", async () => {
    const agent = new Agent({ provider: new MockProvider([textTurn("ok")]) });
    const model = new ConversationModel(agent, () => {});

    type(model, "first");
    model.handleKey(parseChord("shift+return"), undefined);
    type(model, "second");
    expect(model.input).toBe("first\nsecond");
    await submit(model);

    expect(model.entries[0]).toEqual({ kind: "user", text: "first\nsecond" });
    expect(model.input).toBe("");
  });

  it("moves the cursor between lines with up and down while composing", () => {
    const model = new ConversationModel(undefined, () => {});
    type(model, "abc");
    model.handleKey(parseChord("shift+return"), undefined);
    type(model, "z");

    model.handleKey(parseChord("up"), undefined);
    type(model, "!");
    expect(model.input).toBe("a!bc\nz");
  });
});

describe("input history", () => {
  async function conversed(...prompts: string[]): Promise<ConversationModel> {
    const agent = new Agent({
      provider: new MockProvider(prompts.map((prompt) => textTurn(`re: ${prompt}`))),
    });
    const model = new ConversationModel(agent, () => {});
    for (const prompt of prompts) {
      type(model, prompt);
      await submit(model);
    }
    return model;
  }

  it("recalls earlier prompts with up at an empty prompt", async () => {
    const model = await conversed("one", "two");

    model.handleKey(parseChord("up"), undefined);
    expect(model.input).toBe("two");
    model.handleKey(parseChord("up"), undefined);
    expect(model.input).toBe("one");
    model.handleKey(parseChord("down"), undefined);
    expect(model.input).toBe("two");
    model.handleKey(parseChord("down"), undefined);
    expect(model.input).toBe("");
  });

  it("stays put when the prompt has unsent text", async () => {
    const model = await conversed("one");
    type(model, "draft");
    model.handleKey(parseChord("up"), undefined);
    expect(model.input).toBe("draft");
  });

  it("stops browsing as soon as the recalled text is edited", async () => {
    const model = await conversed("one", "two");
    model.handleKey(parseChord("up"), undefined);
    type(model, "!");
    expect(model.input).toBe("two!");
    model.handleKey(parseChord("up"), undefined);
    expect(model.input).toBe("two!");
  });
});

describe("queueing while busy", () => {
  it("queues a second prompt mid-turn and sends it after the first completes", async () => {
    const agent = new Agent({
      provider: new MockProvider([textTurn("first reply"), textTurn("second reply")]),
    });
    const model = new ConversationModel(agent, () => {});

    type(model, "first");
    model.handleKey(parseChord("return"), undefined);
    expect(model.busy).toBe(true);
    type(model, "second");
    model.handleKey(parseChord("return"), undefined);
    expect(model.queued()).toEqual(["second"]);
    expect(model.entries.map((entry) => entry.kind)).toEqual(["user"]);

    let previous: Promise<unknown>;
    do {
      previous = model.lastSend;
      await previous;
    } while (previous !== model.lastSend);

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
    const agent = new Agent({
      provider: new MockProvider([textTurn("re: a"), textTurn("re: b"), textTurn("re: c")]),
    });
    const model = new ConversationModel(agent, () => {});

    for (const prompt of ["a", "b", "c"]) {
      type(model, prompt);
      model.handleKey(parseChord("return"), undefined);
    }
    expect(model.queued()).toEqual(["b", "c"]);

    let previous: Promise<unknown>;
    do {
      previous = model.lastSend;
      await previous;
    } while (previous !== model.lastSend);

    expect(model.entries.map((entry) => entry.text)).toEqual([
      "a",
      "re: a",
      "b",
      "re: b",
      "c",
      "re: c",
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

  it("drops queued prompts on dispose instead of sending them to a dead pane", async () => {
    const agent = new Agent({
      provider: new MockProvider([textTurn("first reply"), textTurn("never sent")]),
    });
    const model = new ConversationModel(agent, () => {});

    type(model, "first");
    model.handleKey(parseChord("return"), undefined);
    type(model, "second");
    model.handleKey(parseChord("return"), undefined);

    model.dispose();
    await model.lastSend;

    expect(model.queued()).toEqual([]);
    expect(agent.history().filter((message) => message.role === "user")).toHaveLength(1);
  });
});

describe("scrollback", () => {
  function longConversation(): ConversationModel {
    const model = new ConversationModel(undefined, () => {});
    model.entries.length = 0;
    for (let at = 1; at <= 20; at += 1) {
      model.entries.push({ kind: "assistant", text: `line ${at}` });
    }
    return model;
  }

  it("pages back through the transcript and clamps at the top", () => {
    const model = longConversation();
    expect(model.visibleTranscript(80, 5).map((line) => line.text)).toEqual([
      "line 16",
      "line 17",
      "line 18",
      "line 19",
      "line 20",
    ]);

    model.handleKey(parseChord("pageup"), undefined);
    expect(model.visibleTranscript(80, 5)[0]?.text).toBe("line 11");

    for (let at = 0; at < 10; at += 1) model.handleKey(parseChord("pageup"), undefined);
    expect(model.visibleTranscript(80, 5)[0]?.text).toBe("line 1");
  });

  it("returns to live with escape", () => {
    const model = longConversation();
    model.visibleTranscript(80, 5);
    model.handleKey(parseChord("pageup"), undefined);
    expect(model.scrollBack).toBeGreaterThan(0);

    expect(model.handleKey(parseChord("escape"), undefined)).toBe(true);
    expect(model.scrollBack).toBe(0);
  });

  it("escape snaps to live before it interrupts a running turn", async () => {
    const agent = new Agent({
      provider: new MockProvider([textTurn(Array.from({ length: 20 }, () => "line").join("\n"))]),
    });
    const model = new ConversationModel(agent, () => {});
    type(model, "go");
    model.handleKey(parseChord("return"), undefined);
    await model.lastSend;
    model.busy = true;
    model.visibleTranscript(80, 5);
    model.handleKey(parseChord("pageup"), undefined);

    model.handleKey(parseChord("escape"), undefined);
    expect(model.scrollBack).toBe(0);
    expect(model.busy).toBe(true);

    model.handleKey(parseChord("escape"), undefined);
    model.busy = false;
  });

  it("scrolls by wheel deltas through scrollBy", () => {
    const model = longConversation();
    model.visibleTranscript(80, 5);
    model.scrollBy(3);
    expect(model.visibleTranscript(80, 5)[0]?.text).toBe("line 13");
    model.scrollBy(-3);
    expect(model.visibleTranscript(80, 5)[0]?.text).toBe("line 16");
  });
});

describe("mutation confirmation", () => {
  const writeCall: ToolCallPart = {
    type: "tool-call",
    callId: "call-1",
    name: "write",
    arguments: { path: "notes.txt" },
  };

  it("holds the ask open, swallowing unrelated keys until answered", async () => {
    const model = new ConversationModel(undefined, () => {});

    const verdict = model.confirmMutation(writeCall);
    expect(model.pendingAsk?.summary).toContain("write");
    expect(model.handleKey(parseChord("z"), "z")).toBe(true);
    expect(model.pendingAsk).toBeDefined();

    model.handleKey(parseChord("y"), "y");
    expect(await verdict).toBe(true);
    expect(model.pendingAsk).toBeUndefined();
  });

  it("denies on n and on escape", async () => {
    const model = new ConversationModel(undefined, () => {});

    const first = model.confirmMutation(writeCall);
    model.handleKey(parseChord("n"), "n");
    expect(await first).toBe(false);

    const second = model.confirmMutation(writeCall);
    model.handleKey(parseChord("escape"), undefined);
    expect(await second).toBe(false);
  });

  it("denies a pending ask on dispose so the agent is never stranded", async () => {
    const model = new ConversationModel(undefined, () => {});
    const verdict = model.confirmMutation(writeCall);

    model.dispose();

    expect(await verdict).toBe(false);
    expect(model.pendingAsk).toBeUndefined();
  });

  it("remembers a for the rest of the session", async () => {
    const model = new ConversationModel(undefined, () => {});

    const first = model.confirmMutation(writeCall);
    model.handleKey(parseChord("a"), "a");
    expect(await first).toBe(true);

    expect(await model.confirmMutation(writeCall)).toBe(true);
    expect(model.pendingAsk).toBeUndefined();
  });
});

describe("paste", () => {
  it("inserts multi-line text into the prompt without submitting", () => {
    const model = new ConversationModel(undefined, () => {});
    type(model, "err: ");
    model.paste("line one\nline two");
    expect(model.input).toBe("err: line one\nline two");
    expect(model.entries.filter((entry) => entry.kind === "user")).toEqual([]);
  });

  it("normalizes CRLF pastes to newlines", () => {
    const model = new ConversationModel(undefined, () => {});
    model.paste("a\r\nb\rc");
    expect(model.input).toBe("a\nb\nc");
  });

  it("ignores pastes while an ask is pending", () => {
    const model = new ConversationModel(undefined, () => {});
    void model.confirmMutation({ type: "tool-call", callId: "c", name: "write", arguments: {} });
    expect(model.paste("sneaky")).toBe(true);
    expect(model.input).toBe("");
    expect(model.pendingAsk).toBeDefined();
  });
});

describe("windowed transcript", () => {
  function bigConversation(): ConversationModel {
    const model = new ConversationModel(undefined, () => {});
    model.entries.length = 0;
    for (let at = 1; at <= 500; at += 1) {
      model.entries.push({ kind: "assistant", text: `entry ${at}` });
    }
    return model;
  }

  it("matches the full wrap-and-slice result at the live edge and scrolled", () => {
    const model = bigConversation();
    const full = transcriptLines(model.entries, 40).map((line) => line.text);

    expect(model.visibleTranscript(40, 8).map((line) => line.text)).toEqual(full.slice(-8));

    model.scrollBy(100);
    expect(model.visibleTranscript(40, 8).map((line) => line.text)).toEqual(full.slice(-108, -100));
  });

  it("clamps a scroll past the top to the oldest window", () => {
    const model = bigConversation();
    model.scrollBy(100_000);
    const window = model.visibleTranscript(40, 8);
    expect(window[0]?.text).toBe("entry 1");
    expect(model.scrollBack).toBe(500 - 8);
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

  it("never splits surrogate pairs when wrapping astral-plane text", () => {
    const lines = transcriptLines([{ kind: "assistant", text: "😀".repeat(7) }], 3);
    expect(lines.map((line) => line.text)).toEqual(["😀😀😀", "😀😀😀", "😀"]);
    for (const line of lines) {
      expect(line.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });

  it("wraps CJK text by code points", () => {
    const lines = transcriptLines([{ kind: "assistant", text: "我们在这里写字" }], 3);
    expect(lines.map((line) => line.text)).toEqual(["我们在", "这里写", "字"]);
  });
});

const replayTempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    replayTempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function replaySessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-model-replay-"));
  replayTempDirs.push(dir);
  return join(dir, "session.jsonl");
}

describe("session replay rendering", () => {
  const listTool: Tool = {
    name: "list",
    description: "lists files",
    parameters: { type: "object" },
    execute: async () => "total 4\ndrwxr-xr-x 2 u u 4096 .",
  };

  async function livedAndRevived(): Promise<{
    live: ConversationModel;
    revived: ConversationModel;
  }> {
    const liveAgent = new Agent({
      provider: new MockProvider([
        [
          {
            type: "tool-call",
            call: { type: "tool-call", callId: "c1", name: "list", arguments: {} },
          },
          { type: "text", text: "Counting the files now." },
          { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
        ],
        textTurn("There are 4 files here."),
      ]),
      tools: [listTool],
    });
    const live = new ConversationModel(liveAgent, () => {});
    live.submitText("how many files?");
    await live.lastSend;

    const store = await SessionStore.create(await replaySessionFile(), ".");
    for (const message of liveAgent.history()) await store.append(message);
    const revivedAgent = new Agent({ provider: new MockProvider([]), history: store.messages() });
    const revived = new ConversationModel(revivedAgent, () => {});
    replaySession(store, revivedAgent.bus);
    return { live, revived };
  }

  it("renders a revived tool-call turn as it rendered live, minus live-only timings", async () => {
    const { live, revived } = await livedAndRevived();
    const rendered = (entries: readonly TranscriptEntry[]) =>
      entries.map(({ kind, text }) => ({
        kind,
        text: text.replace(/ · \d+(\.\d+)?(ms|s|m)/, ""),
      }));
    expect(rendered(revived.entries)).toEqual(rendered(live.entries));
  });

  it("never merges prose across turns around a replayed tool entry", async () => {
    const { revived } = await livedAndRevived();
    expect(revived.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(revived.entries[1]).toEqual({ kind: "assistant", text: "Counting the files now." });
    expect(revived.entries[2]).toMatchObject({ kind: "tool", text: "list · done" });
    expect(revived.entries[3]).toEqual({ kind: "assistant", text: "There are 4 files here." });
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

describe("cost accounting", () => {
  it("shows dollars in the usage summary once every turn is priced", async () => {
    const provider = new MockProvider(
      [textTurn("hi", { inputTokens: 10_000, outputTokens: 1_000 })],
      "gpt-5-mini",
    );
    const model = new ConversationModel(new Agent({ provider }), () => {});
    type(model, "go");
    await submit(model);
    expect(model.usageSummary()).toBe("$0.0045");
  });

  it("keeps showing raw token counts when the model has no pricing", async () => {
    const provider = new MockProvider([textTurn("hi", { inputTokens: 3, outputTokens: 2 })]);
    const model = new ConversationModel(new Agent({ provider }), () => {});
    type(model, "go");
    await submit(model);
    expect(model.usageSummary()).toBe("3▸2");
  });

  it("prefers the provider-metered cost over table estimates", async () => {
    const provider = new MockProvider(
      [textTurn("hi", { inputTokens: 10_000, outputTokens: 1_000, costUsd: 0.9 })],
      "gpt-5-mini",
    );
    const model = new ConversationModel(new Agent({ provider }), () => {});
    type(model, "go");
    await submit(model);
    expect(model.usageSummary()).toBe("$0.90");
  });

  it("stays blank before any usage lands", () => {
    const model = new ConversationModel(new Agent({ provider: new MockProvider([]) }), () => {});
    expect(model.usageSummary()).toBe("");
  });

  it("suggests /cost while typing it, without any commands port", () => {
    const model = new ConversationModel(undefined, () => {});
    type(model, "/cos");
    expect(model.suggestions().map((suggestion) => suggestion.name)).toEqual(["cost"]);
  });

  it("/cost on a fresh session says there is nothing to price yet", () => {
    const model = new ConversationModel(new Agent({ provider: new MockProvider([]) }), () => {});
    type(model, "/cost");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: "no usage yet · send a prompt first",
    });
  });

  it("/cost prints tokens plus an estimated total for a priced model", async () => {
    const provider = new MockProvider(
      [textTurn("hi", { inputTokens: 10_000, outputTokens: 1_000, cacheReadInputTokens: 500 })],
      "gpt-5-mini",
    );
    const model = new ConversationModel(new Agent({ provider }), () => {});
    type(model, "go");
    await submit(model);
    type(model, "/cost");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: "tokens 10000▸1000 · cache read 500\ncost $0.0045 · estimated from gpt-5-mini rates",
    });
  });

  it("/cost admits when a model has no pricing instead of claiming zero", async () => {
    const provider = new MockProvider([textTurn("hi", { inputTokens: 7, outputTokens: 3 })]);
    const model = new ConversationModel(new Agent({ provider }), () => {});
    type(model, "go");
    await submit(model);
    type(model, "/cost");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: "tokens 7▸3\ncost unknown · no pricing for this model",
    });
  });

  it("/cost labels a fully provider-metered total as metered", async () => {
    const provider = new MockProvider([
      textTurn("hi", { inputTokens: 5, outputTokens: 5, costUsd: 0.002 }),
    ]);
    const model = new ConversationModel(new Agent({ provider }), () => {});
    type(model, "go");
    await submit(model);
    type(model, "/cost");
    model.handleKey(parseChord("return"), undefined);
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: "tokens 5▸5\ncost $0.002 · metered by the provider",
    });
  });
});

describe("the page grammar in the transcript", () => {
  function blankModel(): ConversationModel {
    const model = new ConversationModel(undefined, () => {});
    model.entries.length = 0;
    return model;
  }

  it("wraps prose to the broadsheet measure while machine output runs full bleed", () => {
    const model = blankModel();
    model.entries.push({ kind: "assistant", text: "word ".repeat(40).trim() });
    model.entries.push({ kind: "tool", text: `· bash ${"x".repeat(140)}`, failed: false });

    const lines = model.visibleTranscript(150, 60, resolvePage(156));
    const prose = lines.filter((line) => line.kind === "assistant");
    const machine = lines.filter((line) => line.kind === "tool");

    expect(prose.length).toBeGreaterThan(1);
    for (const line of prose) expect(line.text.length).toBeLessThanOrEqual(89);
    expect(Math.max(...machine.map((line) => line.text.length))).toBe(147);
  });

  it("indents prose by the gutter and leaves machine output on the margin", () => {
    const model = blankModel();
    model.entries.push({ kind: "user", text: "go" });
    model.entries.push({ kind: "tool", text: "✓ bash — ok", failed: false });

    const lines = model.visibleTranscript(150, 60, resolvePage(156));
    expect(lines.find((line) => line.kind === "user")?.text).toBe(" go");
    expect(lines.find((line) => line.kind === "tool")?.text).toBe("✓ bash — ok");
  });

  it("re-wraps when a resize crosses a tier threshold", () => {
    const model = blankModel();
    model.entries.push({ kind: "assistant", text: "word ".repeat(40).trim() });

    const broad = model.visibleTranscript(150, 60, resolvePage(156));
    const column = model.visibleTranscript(76, 60, resolvePage(80));

    expect(Math.max(...broad.map((line) => line.text.length))).toBeLessThanOrEqual(89);
    expect(Math.max(...column.map((line) => line.text.length))).toBeLessThanOrEqual(76);
    expect(column.map((line) => line.text)).not.toEqual(broad.map((line) => line.text));
    expect(column[0]?.text.startsWith(" ")).toBe(false);
  });

  it("renders assistant markdown as styled spans and user text verbatim", () => {
    const model = blankModel();
    model.entries.push({ kind: "user", text: "**not markdown**" });
    model.entries.push({ kind: "assistant", text: "**bold**" });

    const lines = model.visibleTranscript(60, 10);
    const user = lines.find((line) => line.kind === "user");
    const assistant = lines.find((line) => line.kind === "assistant");

    expect(user?.text).toBe("**not markdown**");
    expect(user?.spans).toBeUndefined();
    expect(assistant?.text).toBe("bold");
    expect(assistant?.spans).toContainEqual({ text: "bold", tone: "body", bold: true });
  });

  it("runs fence rows on the panel past the prose measure", () => {
    const model = blankModel();
    const wide = "x".repeat(100);
    model.entries.push({ kind: "assistant", text: `\`\`\`ts\n${wide}\n\`\`\`` });

    const lines = model.visibleTranscript(120, 60, resolvePage(126));
    const fenceRows = lines.filter((line) => line.panel === true);

    expect(fenceRows.map((line) => line.text)).toEqual(["▎ ts", `▎ ${wide}`]);
    expect(lines.some((line) => line.text.includes("```"))).toBe(false);
  });
});

describe("the voice rail and tool rows", () => {
  function blankModel(): ConversationModel {
    const model = new ConversationModel(undefined, () => {});
    model.entries.length = 0;
    return model;
  }

  const longOutputTool: Tool = {
    name: "spool",
    description: "spools many lines",
    parameters: { type: "object" },
    execute: async () => Array.from({ length: 20 }, (_, at) => `line ${at + 1}`).join("\n"),
  };

  const failingTool: Tool = {
    name: "detonate",
    description: "always fails",
    parameters: { type: "object" },
    execute: async () => {
      throw new Error("boom");
    },
  };

  async function ranModel(tool: Tool, args: Record<string, unknown> = {}) {
    const agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c1", name: tool.name, arguments: args }),
        textTurn("after"),
      ]),
      tools: [tool],
    });
    const model = new ConversationModel(agent, () => {});
    model.submitText("go");
    await model.lastSend;
    return model;
  }

  it("stamps entries by voice and blanks continuation rows", () => {
    const model = blankModel();
    model.entries.push({ kind: "user", text: "go" });
    model.entries.push({ kind: "assistant", text: "word ".repeat(20).trim() });
    model.entries.push({ kind: "info", text: "a notice" });

    const lines = model.visibleTranscript(30, 40);
    const user = lines.find((line) => line.kind === "user");
    const prose = lines.filter((line) => line.kind === "assistant");
    const info = lines.find((line) => line.kind === "info");

    expect(user?.stamp).toBe("█ ");
    expect(prose[0]?.stamp).toBe("▓ ");
    expect(prose.slice(1).every((line) => line.stamp === "  ")).toBe(true);
    expect(prose.length).toBeGreaterThan(1);
    expect(info?.stamp).toBe("  ");
    for (const line of lines) expect(Array.from(line.text).length).toBeLessThanOrEqual(28);
  });

  it("steps the streaming stamp through the ramp and settles it on interrupt", () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const model = new ConversationModel(agent, () => {});
    const stamp = () =>
      model.visibleTranscript(60, 20).find((line) => line.kind === "assistant")?.stamp;

    agent.bus.emit("turn.delta", { delta: { type: "text", text: "one " } });
    expect(stamp()).toBe("░ ");
    agent.bus.emit("turn.delta", { delta: { type: "text", text: "two " } });
    agent.bus.emit("turn.delta", { delta: { type: "text", text: "three " } });
    expect(stamp()).toBe("▒ ");
    agent.bus.emit("turn.interrupted", { message: textMessage("assistant", "one two three") });
    expect(stamp()).toBe("▓ ");
  });

  it("collapses a settled tool run and discloses detail under a rule on tab", async () => {
    const model = await ranModel(echoTool, { text: "hi" });
    const toolLines = () => model.visibleTranscript(80, 40).filter((line) => line.kind === "tool");

    const folded = toolLines();
    expect(folded).toHaveLength(1);
    expect(folded[0]?.spans).toContainEqual({ text: "done", tone: "ok" });
    expect(folded[0]?.stamp).toBe("░ ");

    expect(model.handleKey(parseChord("tab"), undefined)).toBe(true);
    const open = toolLines();
    expect(open.length).toBeGreaterThan(2);
    expect(open[1]?.spans?.[0]?.tone).toBe("rule");
    expect(open.at(-1)?.text).toBe("echo: hi");
    expect(open.slice(1).every((line) => line.stamp === "  ")).toBe(true);

    expect(model.handleKey(parseChord("tab"), undefined)).toBe(true);
    expect(toolLines()).toHaveLength(1);
  });

  it("leaves tab alone while the prompt holds text", async () => {
    const model = await ranModel(echoTool, { text: "hi" });
    type(model, "draft");
    expect(model.handleKey(parseChord("tab"), undefined)).toBe(false);
    expect(model.visibleTranscript(80, 40).filter((line) => line.kind === "tool")).toHaveLength(1);
  });

  it("caps disclosed detail and marks the overflow", async () => {
    const model = await ranModel(longOutputTool);
    model.handleKey(parseChord("tab"), undefined);
    const lines = model.visibleTranscript(80, 60).filter((line) => line.kind === "tool");
    expect(lines.at(-1)?.text).toBe("… 8 more lines");
    expect(lines.filter((line) => line.text.startsWith("line "))).toHaveLength(12);
  });

  it("carries the failure reason on the collapsed row", async () => {
    const model = await ranModel(failingTool);
    const entry = model.entries.find(
      (candidate): candidate is TranscriptEntry & { kind: "tool" } => candidate.kind === "tool",
    );
    expect(entry?.failed).toBe(true);
    expect(entry?.text).toMatch(/ · failed — /);
    const row = model.visibleTranscript(80, 40).find((line) => line.kind === "tool");
    expect(row?.spans).toContainEqual({ text: "failed", tone: "bad" });
  });

  it("clips an overlong tool row with an ellipsis instead of wrapping", async () => {
    const model = await ranModel(echoTool, { text: "x".repeat(120) });
    const rows = model.visibleTranscript(40, 40).filter((line) => line.kind === "tool");
    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0]?.text ?? "").length).toBeLessThanOrEqual(38);
  });
});
