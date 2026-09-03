import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Message,
  MockProvider,
  type Provider,
  SessionStore,
  type ToolCallPart,
  textMessage,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { type ChatIo, type ChatOptions, chat, persistNewMessages } from "./chat.ts";
import type { PresetPort } from "./presets.ts";
import { latestSessionFile } from "./sessions/store.ts";

const tempDir = scratchDirs("keywork-chat-");

interface ScriptedIo extends ChatIo {
  out: string[];
  err: string[];
  streamed: string[];
  closed: number;
}

interface Script {
  lines: string[];
  keys?: string[];
  interactive?: boolean;
}

function scriptedIo({ lines, keys = [], interactive = true }: Script): ScriptedIo {
  const answers = [...lines];
  const pressed = [...keys];
  const io: ScriptedIo = {
    interactive,
    out: [],
    err: [],
    streamed: [],
    closed: 0,
    readLine: async () => answers.shift(),
    readKey: async () => {
      const name = pressed.shift();
      return name === undefined ? undefined : { name, ctrl: false, sequence: name };
    },
    onKey: () => () => {},
    confirm: async (question) => {
      io.out.push(question);
      return (answers.shift() ?? "").startsWith("y");
    },
    close: () => {
      io.closed += 1;
    },
    print: (line) => io.out.push(line),
    printError: (line) => io.err.push(line),
    write: (text) => io.streamed.push(text),
  };
  return io;
}

interface World {
  cwd: string;
  sessionDir: string;
  options: (provider: Provider, overrides?: Partial<ChatOptions>) => ChatOptions;
}

async function world(): Promise<World> {
  const cwd = await tempDir();
  const sessionDir = join(cwd, "sessions");
  return {
    cwd,
    sessionDir,
    options: (provider, overrides = {}) => ({
      cwd,
      provider,
      label: "mock/test",
      sessionDir,
      userRoot: join(cwd, "user-keywork"),
      checkpointsGitDir: join(cwd, "snapshots-git"),
      ...overrides,
    }),
  };
}

async function savedMessages(sessionDir: string): Promise<Message[]> {
  const file = await latestSessionFile(sessionDir);
  if (file === undefined) throw new Error("no session file");
  return [...(await SessionStore.open(file)).messages()];
}

function writeCall(callId: string, path: string, content: string): ToolCallPart {
  return { type: "tool-call", callId, name: "write", arguments: { path, content } };
}

describe("chat REPL", () => {
  it("greets, runs a prompt through the agent, streams the reply, and persists the turn", async () => {
    const { options, sessionDir, cwd } = await world();
    const io = scriptedIo({ lines: ["hi there"] });

    await chat(options(new MockProvider([textTurn("hello back")])), io);

    expect(io.out[0]).toBe(`keywork · mock/test · ${cwd}`);
    expect(io.streamed.join("")).toContain("hello back");
    expect(io.out.some((line) => line.startsWith("  · session "))).toBe(true);
    const messages = await savedMessages(sessionDir);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(io.closed).toBe(1);
  });

  it("skips blank lines and stops at exit, quit, or end of input", async () => {
    const { options } = await world();
    const io = scriptedIo({ lines: ["", "   ", "quit", "/session"] });

    await chat(options(new MockProvider([])), io);

    expect(io.out.some((line) => line.startsWith("file "))).toBe(false);
  });

  it("/session prints the session facts", async () => {
    const { options } = await world();
    const io = scriptedIo({ lines: ["/session"] });

    await chat(options(new MockProvider([])), io);

    expect(io.out.some((line) => line.startsWith("file      "))).toBe(true);
    expect(io.out.some((line) => line.startsWith("id        "))).toBe(true);
    expect(io.out).toContain("entries   0 (0 messages, 0 branch points, 0 labels, 0 compactions)");
    expect(io.out).toContain("tokens    0 in / 0 out this run");
  });

  it("/label bookmarks the leaf and explains itself before a turn or without a name", async () => {
    const { options, sessionDir } = await world();
    const io = scriptedIo({ lines: ["/label early", "hi", "/label", "/label good-path"] });

    await chat(options(new MockProvider([textTurn("ok")])), io);

    expect(io.out).toContain("nothing to label yet");
    expect(io.out).toContain("usage: /label <name>");
    expect(io.out.some((line) => /^labeled [0-9a-f]{8} as "good-path"$/.test(line))).toBe(true);
    const file = await latestSessionFile(sessionDir);
    expect((await SessionStore.open(file ?? "")).entryForLabel("good-path")).toBeDefined();
  });

  it("treats /labelfoo as an unknown command, never as /label", async () => {
    const { options } = await world();
    const io = scriptedIo({ lines: ["/labelfoo"] });

    await chat(options(new MockProvider([])), io);

    expect(io.err).toEqual([expect.stringContaining("unknown command /labelfoo · /session")]);
    expect(io.out).not.toContain("usage: /label <name>");
  });

  it("/undo and /redo report when there is nothing to move", async () => {
    const { options } = await world();
    const io = scriptedIo({ lines: ["/undo", "/redo"] });

    await chat(options(new MockProvider([])), io);

    expect(io.out).toContain("nothing to undo");
    expect(io.out).toContain("nothing to redo");
  });

  it("/preset lists, asks before loosening, and applies through the port", async () => {
    const { options } = await world();
    const applied: string[] = [];
    const presets: PresetPort = {
      active: () => "standard",
      apply: async (name) => {
        applied.push(name);
      },
    };
    const io = scriptedIo({ lines: ["/preset", "/preset open", "y"] });

    await chat(options(new MockProvider([]), { presets }), io);

    expect(io.out).toContain("careful · standard* · open");
    expect(io.out.some((line) => line.includes("loosens permissions"))).toBe(true);
    expect(applied).toEqual(["open"]);
    expect(io.out).toContain("permissions preset → open");
  });

  it("/compact reports that a fresh session has nothing to fold", async () => {
    const { options } = await world();
    const io = scriptedIo({ lines: ["/compact"] });

    await chat(options(new MockProvider([])), io);

    expect(io.out.some((line) => line.includes("nothing to compact yet"))).toBe(true);
  });

  it("/agent explains when no agents are defined", async () => {
    const { options } = await world();
    const io = scriptedIo({ lines: ["/agent"] });

    await chat(options(new MockProvider([])), io);

    expect(io.out).toContain("no agents yet, add one at .keywork/agents/<name>.md");
  });

  it("/agent lists, switches, rejects unknown names, and clears", async () => {
    const { options, cwd } = await world();
    await mkdir(join(cwd, ".keywork", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".keywork", "agents", "helper.md"),
      "---\ndescription: Helps out\n---\nBe helpful.",
    );
    const io = scriptedIo({ lines: ["/agent", "/agent helper", "/agent ghost", "/agent none"] });

    await chat(options(new MockProvider([]), { projectTrusted: true }), io);

    expect(io.out).toContain("/agent <name> to switch · /agent none to clear");
    expect(io.out).toContain("  helper · Helps out");
    expect(io.out).toContain("agent → helper");
    expect(io.out).toContain('unknown agent "ghost"');
    expect(io.out).toContain("back to the default agent");
  });

  it("renders an extension command and sends the rendered prompt", async () => {
    const { options, cwd, sessionDir } = await world();
    await mkdir(join(cwd, ".keywork", "commands"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "commands", "ship.md"), "Ship $ARGUMENTS now");
    const io = scriptedIo({ lines: ["/ship the fix"] });

    await chat(options(new MockProvider([textTurn("shipped")]), { projectTrusted: true }), io);

    expect(io.out).toContain("commands: /ship");
    const [prompt] = await savedMessages(sessionDir);
    expect(prompt).toEqual(textMessage("user", "Ship the fix now"));
  });

  it("reports a provider failure and keeps the REPL alive", async () => {
    const { options } = await world();
    const failing: Provider = {
      name: "broken",
      // biome-ignore lint/correctness/useYield: the failure is the point of this provider
      stream: async function* () {
        throw new Error("upstream is down");
      },
    };
    const io = scriptedIo({ lines: ["hi", "/session"] });

    await chat(options(failing), io);

    expect(io.err).toContain("\nerror: upstream is down");
    expect(io.out.some((line) => line.startsWith("file      "))).toBe(true);
  });

  it("prints the error and stops when the resume id matches nothing", async () => {
    const { options } = await world();
    const io = scriptedIo({ lines: ["/session"] });

    await chat(options(new MockProvider([]), { resumeId: "nope" }), io);

    expect(io.err).toEqual(["no session matches id nope"]);
    expect(io.out).toEqual([]);
    expect(io.closed).toBe(1);
  });

  it("resumes the latest session and reports the seeded messages", async () => {
    const { options, sessionDir } = await world();
    await chat(options(new MockProvider([textTurn("first")])), scriptedIo({ lines: ["one"] }));
    const io = scriptedIo({ lines: [] });

    await chat(options(new MockProvider([]), { resume: true }), io);

    expect(io.out).toContain("resumed 2 messages");
    expect(await savedMessages(sessionDir)).toHaveLength(2);
  });
});

describe("chat return delta", () => {
  async function trustedVault(cwd: string): Promise<string> {
    const vault = join(cwd, ".keywork", "memory");
    await mkdir(vault, { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "fixture" }));
    return vault;
  }

  it("tells a resumed session what changed while it was away, then stays quiet", async () => {
    const { options, cwd } = await world();
    const vault = await trustedVault(cwd);
    await chat(
      options(new MockProvider([textTurn("first")]), { projectTrusted: true }),
      scriptedIo({ lines: ["one"] }),
    );
    await writeFile(
      join(vault, "Fresh Rule.md"),
      "---\ncreated: 2099-01-01T00:00:00.000Z\nprovenance: agent\n---\nnew\n",
    );

    const io = scriptedIo({ lines: [] });
    await chat(options(new MockProvider([]), { projectTrusted: true, resume: true }), io);
    expect(io.out).toContain("since you were here: 1 new in the workspace: [[Fresh Rule]]");
  });

  it("says nothing on resume when nothing changed, and nothing on a fresh session", async () => {
    const { options, cwd } = await world();
    await trustedVault(cwd);
    const fresh = scriptedIo({ lines: [] });
    await chat(options(new MockProvider([]), { projectTrusted: true }), fresh);
    expect(fresh.out.some((line) => line.startsWith("since you were here"))).toBe(false);

    await chat(
      options(new MockProvider([textTurn("first")]), { projectTrusted: true }),
      scriptedIo({ lines: ["one"] }),
    );
    const resumed = scriptedIo({ lines: [] });
    await chat(options(new MockProvider([]), { projectTrusted: true, resume: true }), resumed);
    expect(resumed.out.some((line) => line.startsWith("since you were here"))).toBe(false);
  });
});

describe("chat mutation guard", () => {
  it("refuses asks without a terminal, like headless, instead of approving them", async () => {
    const { options, cwd } = await world();
    const provider = new MockProvider([
      toolCallTurn(writeCall("call-1", "note.txt", "hello")),
      textTurn("done"),
    ]);
    const io = scriptedIo({ lines: ["write a note"], interactive: false });

    await chat(options(provider), io);

    expect(existsSync(join(cwd, "note.txt"))).toBe(false);
    expect(io.err).toContain("  ? write needs approval and there is no terminal to ask · refused");
    expect(io.out.some((line) => line.startsWith("  ✗ not approved"))).toBe(true);
  });

  it("asks once per call and stops asking after 'always'", async () => {
    const { options, cwd } = await world();
    const provider = new MockProvider([
      toolCallTurn(writeCall("call-1", "one.txt", "1")),
      toolCallTurn(writeCall("call-2", "two.txt", "2")),
      textTurn("done"),
    ]);
    const io = scriptedIo({ lines: ["write two notes"], keys: ["x", "a"] });

    await chat(options(provider), io);

    expect(await readFile(join(cwd, "one.txt"), "utf8")).toBe("1");
    expect(await readFile(join(cwd, "two.txt"), "utf8")).toBe("2");
    expect(io.out.filter((line) => line.includes("[y] allow  [a] always  [n] deny"))).toHaveLength(
      1,
    );
  });

  it("denies on 'n' and records the refusal in the transcript", async () => {
    const { options, cwd } = await world();
    const provider = new MockProvider([
      toolCallTurn(writeCall("call-1", "note.txt", "hello")),
      textTurn("done"),
    ]);
    const io = scriptedIo({ lines: ["write a note"], keys: ["n"] });

    await chat(options(provider), io);

    expect(existsSync(join(cwd, "note.txt"))).toBe(false);
    expect(io.out).toContain("  ✗ declined by user");
  });

  it("denies when the key stream ends before an answer", async () => {
    const { options, cwd } = await world();
    const provider = new MockProvider([
      toolCallTurn(writeCall("call-1", "note.txt", "hello")),
      textTurn("done"),
    ]);
    const io = scriptedIo({ lines: ["write a note"], keys: [] });

    await chat(options(provider), io);

    expect(existsSync(join(cwd, "note.txt"))).toBe(false);
  });
});

describe("persistNewMessages", () => {
  async function tempStore(): Promise<SessionStore> {
    const dir = await tempDir();
    return SessionStore.create(join(dir, "session.jsonl"), dir);
  }

  const turn = (prompt: string, reply: string): Message[] => [
    textMessage("user", prompt),
    textMessage("assistant", reply),
  ];

  it("tags each persisted user prompt with the turn's checkpoint tree", async () => {
    const store = await tempStore();
    const tags = ["tree-one", "tree-two"];
    const checkpoints = { takeTurnTag: () => tags.shift() };

    let persisted = await persistNewMessages(store, turn("one", "re: one"), 0, checkpoints);
    persisted = await persistNewMessages(
      store,
      [...turn("one", "re: one"), ...turn("two", "re: two")],
      persisted,
      checkpoints,
    );

    expect(persisted).toBe(4);
    const entries = store.entries();
    expect(entries[0]).toMatchObject({ checkpoint: "tree-one" });
    expect(entries[1]).not.toHaveProperty("checkpoint");
    expect(entries[2]).toMatchObject({ checkpoint: "tree-two" });
    expect(entries[3]).not.toHaveProperty("checkpoint");
  });

  it("persists untagged when checkpoints are unavailable", async () => {
    const store = await tempStore();
    await persistNewMessages(store, turn("one", "re: one"), 0);
    expect(store.entries()[0]).not.toHaveProperty("checkpoint");
  });
});

describe("chat turn queue", () => {
  function gatedProvider(replies: string[]): { provider: Provider; open: () => void } {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let turn = 0;
    const provider: Provider = {
      name: "gated",
      async *stream(request) {
        const reply = replies[turn] ?? "";
        turn += 1;
        if (turn === 1) {
          await Promise.race([
            gate,
            new Promise<void>((resolve) =>
              request.signal?.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
          if (request.signal?.aborted) throw new Error("aborted");
        }
        yield* textTurn(reply);
      },
    };
    return { provider, open };
  }

  it("a line typed mid-turn queues in the engine and runs after settlement, in order", async () => {
    const { options, sessionDir } = await world();
    const { provider, open } = gatedProvider(["re: one", "re: two"]);
    const io = scriptedIo({ lines: ["one", "two", "/session"] });
    const originalReadLine = io.readLine;
    io.readLine = async (prompt, readOptions) => {
      const line = await originalReadLine(prompt, readOptions);
      if (line === "/session") open();
      return line;
    };

    await chat(options(provider), io);

    expect(io.out).toContain("  · queued");
    expect(io.streamed.join("")).toBe("re: onere: two");
    const usageLines = io.out.filter((line) => line.startsWith("  · session "));
    expect(usageLines).toHaveLength(2);
    const messages = await savedMessages(sessionDir);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(io.out.some((line) => line.startsWith("file      "))).toBe(true);
  });

  it("/steer interrupts the running turn and sends now; /queue waits its turn", async () => {
    const { options, sessionDir } = await world();
    const { provider } = gatedProvider(["never", "steered", "later"]);
    const io = scriptedIo({ lines: ["slow", "/queue later", "/steer now"] });

    await chat(options(provider), io);

    expect(io.out).toContain("  · queued");
    expect(io.out).toContain("  · steering");
    expect(io.out).toContain("\n(interrupted)");
    expect(io.streamed.join("")).toBe("steeredlater");
    const messages = await savedMessages(sessionDir);
    expect(messages.map((message) => `${message.role}:${message.parts.length}`)).toEqual([
      "user:1",
      "user:1",
      "assistant:1",
      "user:1",
      "assistant:1",
    ]);
  });

  it("/steer and /queue without text explain themselves", async () => {
    const { options } = await world();
    const io = scriptedIo({ lines: ["/steer", "/queue  "] });

    await chat(options(new MockProvider([])), io);

    expect(io.out).toContain("usage: /steer <prompt>");
    expect(io.out).toContain("usage: /queue <prompt>");
  });
});
