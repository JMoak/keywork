import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  MockProvider,
  memoryFlushPrompt,
  messageText,
  replaySession,
  SessionStore,
  type SessionTreeNode,
  type Tool,
  textMessage,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import { type CheckpointsPort, forkAtPrompt } from "./fork.ts";
import { AppProbe } from "./probe.ts";
import { bindSessionLifecycle, type SessionAttachment } from "./session-attachment.ts";
import type { SessionTreePort } from "./session-tree-pane.ts";
import { waitFor } from "./testing/index.ts";

describe("conversation round-trip", () => {
  it("sends a prompt and streams the scripted reply into the pane", async () => {
    const probe = new AppProbe({
      script: [textTurn("hey there", { inputTokens: 3, outputTokens: 5 })],
    });
    probe.type("hi").keys("enter");
    await probe.settled();

    expect(probe.model()?.entries).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hey there" },
    ]);
    expect(probe.snapshot().panes[0]?.title).toBe("session-1 · 3▸5");
  });
});

describe("safety net", () => {
  it("announces undo and redo outcomes in the status notice", async () => {
    const probe = new AppProbe({
      undo: { undo: async () => true, redo: async () => false },
    });

    expect(probe.command("undo")).toBe(true);
    await waitFor(() => expect(probe.snapshot().notice).toBe("files put back"));

    expect(probe.command("redo")).toBe(true);
    await waitFor(() => expect(probe.snapshot().notice).toBe("nothing to redo"));

    probe.keys("a");
    expect(probe.snapshot().notice).toBe("");
  });

  it("hides undo commands when no checkpoint store is wired", () => {
    const probe = new AppProbe();
    expect(probe.command("undo")).toBe(false);
  });

  it("pauses a mutating tool on the ask and runs it after y", async () => {
    const executed: string[] = [];
    const scribble: Tool = {
      name: "scribble",
      description: "writes",
      parameters: { type: "object" },
      mutates: true,
      execute: async () => {
        executed.push("scribble");
        return "wrote";
      },
    };
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        let pane: ConversationPane | undefined;
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({ type: "tool-call", callId: "c1", name: "scribble", arguments: {} }),
            textTurn("done"),
          ]),
          tools: [scribble],
          guard: { confirm: (call) => pane?.confirmMutation(call) ?? Promise.resolve(true) },
        });
        pane = new ConversationPane(id, agent, notify, undefined, commands);
        return pane;
      },
    });

    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk).toBeDefined());
    expect(executed).toEqual([]);

    probe.keys("y");
    await probe.settled();

    expect(executed).toEqual(["scribble"]);
    expect(probe.model()?.entries.at(-1)).toEqual({ kind: "assistant", text: "done" });
  });

  it("feeds a decline back to the agent as an errored tool result", async () => {
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        let pane: ConversationPane | undefined;
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({ type: "tool-call", callId: "c1", name: "scribble", arguments: {} }),
            textTurn("understood"),
          ]),
          tools: [
            {
              name: "scribble",
              description: "writes",
              parameters: { type: "object" },
              mutates: true,
              execute: async () => "wrote",
            },
          ],
          guard: { confirm: (call) => pane?.confirmMutation(call) ?? Promise.resolve(true) },
        });
        pane = new ConversationPane(id, agent, notify, undefined, commands);
        return pane;
      },
    });

    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk).toBeDefined());
    probe.keys("n");
    await probe.settled();

    const declined = probe.model()?.entries.find((entry) => entry.kind === "tool");
    expect(declined).toMatchObject({ kind: "tool", failed: true });
    expect(declined?.text).toContain("scribble");
    expect(declined?.text).toContain("failed · declined by user");
  });
});

describe("live tool tail-follow", () => {
  function tailProbe(finishTool: Promise<void>) {
    const agents: Agent[] = [];
    const streaming: Tool = {
      name: "slow",
      description: "streams output",
      parameters: { type: "object" },
      execute: async () => {
        const agent = agents[0];
        agent?.bus.emit("tool.output", { chunk: "step 1\n\x1b[31mstep 2\x1b[0m\n" });
        agent?.bus.emit("tool.output", { chunk: `step 3 ${"x".repeat(500)}\n` });
        await finishTool;
        return "final result";
      },
    };
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({ type: "tool-call", callId: "t1", name: "slow", arguments: {} }),
            textTurn("done"),
          ]),
          tools: [streaming],
        });
        agents.push(agent);
        return new ConversationPane(id, agent, notify, undefined, commands);
      },
    });
    return { probe, agents };
  }

  it("streams the live tail inside the tool row and settles it to the one-liner", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { probe, agents } = tailProbe(gate);
    probe.type("go").keys("enter");
    await waitFor(() => {
      const entry = probe.model()?.entries.find((candidate) => candidate.kind === "tool");
      expect(entry?.text).toContain("step 3");
    });

    const running = probe.model()?.entries.find((entry) => entry.kind === "tool");
    expect(running?.text).toMatch(/^slow · /);
    expect(running?.text.includes("\x1b")).toBe(false);
    expect(running?.text.includes("step 2")).toBe(false);
    const runningLines = (probe.model()?.visibleTranscript(38, 12) ?? []).filter(
      (line) => line.kind === "tool",
    );
    expect(runningLines).toHaveLength(1);
    expect(runningLines[0]?.stamp).toBe("░ ");
    for (const line of runningLines) {
      expect(Array.from(line.text).length).toBeLessThanOrEqual(36);
    }

    release();
    await probe.settled();

    const settled = probe.model()?.entries.find((entry) => entry.kind === "tool");
    expect(settled?.text).toMatch(/^slow · \d+(\.\d+)?(ms|s|m) · done$/);
    expect(settled).toMatchObject({ failed: false });
    if (settled?.kind === "tool") {
      expect(settled.run?.detail).toEqual(["final result"]);
      expect(settled.run?.live).toBeUndefined();
    }

    const toolResults = (agents[0]?.history() ?? [])
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.parts);
    expect(toolResults).toEqual([
      { type: "tool-result", callId: "t1", output: "final result", isError: false },
    ]);
  });
});

describe("diff preview in the ask", () => {
  function writeAskProbe(
    files: Record<string, string>,
    executed: string[],
    call: { name: string; arguments: unknown },
  ) {
    return new AppProbe({
      createPane: (id, notify, commands) => {
        let pane: ConversationPane | undefined;
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({
              type: "tool-call",
              callId: "m1",
              name: call.name,
              arguments: call.arguments,
            }),
            textTurn("done"),
          ]),
          tools: [
            {
              name: call.name,
              description: "mutates",
              parameters: { type: "object" },
              mutates: true,
              execute: async () => {
                executed.push(call.name);
                return "ok";
              },
            },
          ],
          guard: {
            confirm: (askedCall) => pane?.confirmMutation(askedCall) ?? Promise.resolve(true),
          },
        });
        pane = new ConversationPane(id, agent, notify, undefined, commands, {
          ports: { readFile: (path) => files[path] },
        });
        return pane;
      },
    });
  }

  it("renders the pending write as a unified diff and only runs it after y", async () => {
    const executed: string[] = [];
    const probe = writeAskProbe({ "notes.txt": "alpha\nbeta\ngamma\n" }, executed, {
      name: "write",
      arguments: { path: "notes.txt", content: "alpha\nBETA\ngamma\n" },
    });
    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk?.diff).toBeDefined());
    expect(executed).toEqual([]);

    const window = probe.model()?.askDiffWindow(10);
    expect(window?.lines).toContainEqual({ kind: "del", text: "beta" });
    expect(window?.lines).toContainEqual({ kind: "add", text: "BETA" });

    probe.keys("down");
    expect(probe.model()?.pendingAsk).toBeDefined();

    probe.keys("y");
    await probe.settled();
    expect(executed).toEqual(["write"]);
  });

  it("scrolls a long diff inside a bounded window without answering the ask", async () => {
    const before = Array.from({ length: 40 }, (_, at) => `old ${at}`).join("\n");
    const after = Array.from({ length: 40 }, (_, at) => `new ${at}`).join("\n");
    const probe = writeAskProbe({ "big.txt": before }, [], {
      name: "write",
      arguments: { path: "big.txt", content: after },
    });
    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk?.diff).toBeDefined());

    const top = probe.model()?.askDiffWindow(5);
    expect(top?.above).toBe(0);
    expect(top?.below).toBeGreaterThan(0);

    probe.keys("down", "down");
    expect(probe.model()?.askDiffWindow(5).above).toBe(2);
    probe.keys("up", "up", "up");
    expect(probe.model()?.askDiffWindow(5).above).toBe(0);
    expect(probe.model()?.pendingAsk).toBeDefined();

    probe.keys("n");
    await probe.settled();
  });

  it("keeps the plain ask for non-write tools", async () => {
    const executed: string[] = [];
    const probe = writeAskProbe({}, executed, {
      name: "bash",
      arguments: { command: "echo hi" },
    });
    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk).toBeDefined());
    expect(probe.model()?.pendingAsk?.diff).toBeUndefined();
    probe.keys("y");
    await probe.settled();
    expect(executed).toEqual(["bash"]);
  });
});

describe("esc-backtrack prompt stepping", () => {
  interface ForkRequest {
    promptId: string;
    draft: string;
  }

  function identifyingAttachment(): SessionAttachment {
    return {
      id: "sess-1",
      history: [],
      replay: () => {},
      append: async (message) =>
        message.role === "user" ? { entryId: `entry:${messageText(message)}` } : undefined,
    };
  }

  function backtrackProbe(
    forks: ForkRequest[],
    outcome: boolean | (() => Promise<boolean>) = true,
    identified = true,
  ) {
    return new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({
          provider: new MockProvider([textTurn("re: one"), textTurn("re: two")]),
        });
        const pane = new ConversationPane(id, agent, notify, undefined, commands, {
          ports: {
            forkAtPrompt: async (promptId, draft) => {
              forks.push({ promptId, draft });
              const forked = typeof outcome === "boolean" ? outcome : await outcome();
              return { forked };
            },
          },
        });
        if (identified) bindSessionLifecycle({ pane, attachment: identifyingAttachment() });
        return pane;
      },
    });
  }

  async function conversed(probe: AppProbe, ...prompts: string[]): Promise<AppProbe> {
    for (const prompt of prompts) {
      probe.type(prompt).keys("enter");
      await probe.settled();
    }
    return probe;
  }

  it("does nothing on esc-esc when no prompts exist", () => {
    const probe = new AppProbe();
    probe.keys("escape", "escape");
    expect(probe.model()?.backtracking()).toBe(false);
    expect(probe.model()?.entries.filter((entry) => entry.kind === "user")).toEqual([]);
  });

  it("walks prior prompts with a visible highlight and cancels on escape", async () => {
    const probe = await conversed(backtrackProbe([]), "one", "two");
    probe.keys("escape", "escape");
    expect(probe.model()?.backtracking()).toBe(true);

    const selectedText = () =>
      (probe.model()?.visibleTranscript(60, 12) ?? [])
        .filter((line) => line.selected === true)
        .map((line) => line.text);
    expect(selectedText()).toEqual(["two"]);

    probe.keys("up");
    expect(selectedText()).toEqual(["one"]);
    probe.keys("up");
    expect(selectedText()).toEqual(["one"]);
    probe.keys("down");
    expect(selectedText()).toEqual(["two"]);

    probe.keys("escape");
    expect(probe.model()?.backtracking()).toBe(false);
    expect(selectedText()).toEqual([]);
  });

  it("stepping past the newest prompt leaves backtrack quietly", async () => {
    const probe = await conversed(backtrackProbe([]), "one", "two");
    probe.keys("escape", "escape", "down");
    expect(probe.model()?.backtracking()).toBe(false);
  });

  it("enter forks at the selected prompt's own entry, including the very first one", async () => {
    const forks: ForkRequest[] = [];
    const probe = await conversed(backtrackProbe(forks), "one", "two");
    probe.keys("escape", "escape", "up", "enter");
    await probe.settled();

    expect(forks).toEqual([{ promptId: "entry:one", draft: "one" }]);
    expect(probe.model()?.backtracking()).toBe(false);
    expect(probe.model()?.entries.filter((entry) => entry.kind === "info")).toEqual([]);
  });

  it("reports truthfully when the fork cannot happen", async () => {
    const forks: ForkRequest[] = [];
    const probe = await conversed(backtrackProbe(forks, false), "one");
    probe.keys("escape", "escape", "enter");
    await probe.settled();

    expect(forks).toEqual([{ promptId: "entry:one", draft: "one" }]);
    expect(probe.model()?.entries.at(-1)).toEqual({
      kind: "info",
      text: "no fork point there",
    });
  });

  it("refuses to fork at a prompt the store never acknowledged instead of guessing", async () => {
    const forks: ForkRequest[] = [];
    const probe = await conversed(backtrackProbe(forks, true, false), "one");
    probe.keys("escape", "escape", "enter");
    await probe.settled();

    expect(forks).toEqual([]);
    expect(probe.model()?.entries.at(-1)).toEqual({
      kind: "info",
      text: "no fork point there",
    });
  });

  it("says so when no fork port is wired instead of silently dropping", async () => {
    const probe = new AppProbe({ script: [textTurn("re: one")] });
    probe.type("one").keys("enter");
    await probe.settled();
    probe.keys("escape", "escape", "enter");
    await probe.settled();
    expect(probe.model()?.entries.at(-1)).toEqual({
      kind: "info",
      text: "can't fork · no session store",
    });
  });

  it("interrupts instead of backtracking while the agent is busy", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agents: Agent[] = [];
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({ type: "tool-call", callId: "b1", name: "block", arguments: {} }),
          ]),
          tools: [
            {
              name: "block",
              description: "waits",
              parameters: { type: "object" },
              execute: async () => {
                await gate;
                return "done";
              },
            },
          ],
        });
        agents.push(agent);
        return new ConversationPane(id, agent, notify, undefined, commands);
      },
    });
    probe.type("go").keys("enter");
    await waitFor(() => expect(agents[0]?.busy()).toBe(true));

    probe.keys("escape", "escape");
    expect(probe.model()?.backtracking()).toBe(false);

    release();
    await probe.settled();
    expect(probe.model()?.busy).toBe(false);
  });

  it("forks a replayed prompt by the entry id replay carried", async () => {
    const forks: ForkRequest[] = [];
    const agents: Agent[] = [];
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({ provider: new MockProvider([textTurn("re: new")]) });
        agents.push(agent);
        return new ConversationPane(id, agent, notify, undefined, commands, {
          ports: {
            forkAtPrompt: async (promptId, draft) => {
              forks.push({ promptId, draft });
              return { forked: true };
            },
          },
        });
      },
    });
    agents[0]?.bus.emit("turn.started", { userText: "old prompt", replay: true, entryId: "u-old" });
    probe.type("new prompt").keys("enter");
    await probe.settled();

    probe.keys("escape", "escape", "up", "enter");
    await probe.settled();
    expect(forks).toEqual([{ promptId: "u-old", draft: "old prompt" }]);
  });

  it("opens a forked pane with the chosen prompt preloaded for editing", () => {
    const probe = new AppProbe();
    probe.core.openPane(undefined, "edit me first");
    expect(probe.model()?.input).toBe("edit me first");
  });
});

describe("conversation pane completion", () => {
  it("scrolls the transcript with the wheel and snaps back on escape", async () => {
    const probe = new AppProbe({
      script: [textTurn(Array.from({ length: 30 }, (_, at) => `line ${at + 1}`).join("\n"))],
    });
    probe.type("go").keys("enter");
    await probe.settled();

    const rect = probe.rect("session-1");
    probe.scroll(rect.x + 2, rect.y + 2, "up", 3);
    expect(probe.model()?.scrollBack).toBe(3);

    probe.keys("escape");
    expect(probe.model()?.scrollBack).toBe(0);
  });

  it("composes a multiline prompt and queues a follow-up while busy", async () => {
    const probe = new AppProbe({ script: [textTurn("first reply"), textTurn("second reply")] });
    probe.type("hello").keys("shift+return").type("world").keys("enter");
    probe.type("follow-up").keys("enter");
    await probe.settled();

    expect(probe.model()?.entries).toEqual([
      { kind: "user", text: "hello\nworld" },
      { kind: "assistant", text: "first reply" },
      { kind: "user", text: "follow-up" },
      { kind: "assistant", text: "second reply" },
    ]);
  });
});

describe("retrieval disclosure", () => {
  it("renders exactly once per session, quietly, in the feed", () => {
    const probe = new AppProbe();
    const pane = probe.core.panes.get("session-1") as ConversationPane;
    pane.discloseRetrieval("memory search uses embeddings from voyage-3");
    pane.discloseRetrieval("memory search uses embeddings from voyage-3");
    const disclosures = probe
      .model()
      ?.entries.filter((entry) => entry.kind === "info" && entry.text.includes("embeddings"));
    expect(disclosures).toEqual([
      { kind: "info", text: "memory search uses embeddings from voyage-3" },
    ]);
  });
});

describe("checkpoint-paired backtrack fork", () => {
  const treeHash = "a".repeat(40);

  function promptRoots(checkpoint?: string): SessionTreeNode[] {
    const second: SessionTreeNode = {
      entry: {
        type: "message",
        id: "u2",
        parentId: "a1",
        timestamp: "",
        message: textMessage("user", "two"),
        ...(checkpoint !== undefined && { checkpoint }),
      },
      children: [],
      onActivePath: true,
    };
    const reply: SessionTreeNode = {
      entry: {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "",
        message: textMessage("assistant", "re: one"),
      },
      children: [second],
      onActivePath: true,
    };
    return [
      {
        entry: {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "",
          message: textMessage("user", "one"),
        },
        children: [reply],
        onActivePath: true,
      },
    ];
  }

  function forkWorld(options: { checkpoint?: string; restoreError?: Error } = {}) {
    const restored: string[] = [];
    const opened: (string | undefined)[] = [];
    const trees: SessionTreePort = {
      load: async (sessionId) => ({ sessionId, roots: promptRoots(options.checkpoint) }),
      setLabel: async () => {},
      fork: async () => "forked-1",
    };
    const checkpoints: CheckpointsPort = {
      capture: async () => {},
      undo: async () => false,
      redo: async () => false,
      restoreTo: async (tree) => {
        if (options.restoreError !== undefined) throw options.restoreError;
        restored.push(tree);
      },
    };
    return {
      restored,
      opened,
      fork: (promptId: string, draft: string) =>
        forkAtPrompt(
          trees,
          (sessionId) => opened.push(sessionId),
          checkpoints,
          "s1",
          promptId,
          draft,
        ),
    };
  }

  it("restores files to the prompt's checkpoint and says so", async () => {
    const world = forkWorld({ checkpoint: treeHash });
    const outcome = await world.fork("u2", "two");
    expect(outcome).toEqual({ forked: true, note: "files put back to that point" });
    expect(world.restored).toEqual([treeHash]);
    expect(world.opened).toEqual(["forked-1"]);
  });

  it("forks truthfully without touching files when the prompt was never checkpointed", async () => {
    const world = forkWorld();
    const outcome = await world.fork("u2", "two");
    expect(outcome).toEqual({ forked: true, note: "forked · files untouched" });
    expect(world.restored).toEqual([]);
    expect(world.opened).toEqual(["forked-1"]);
  });

  it("keeps the conversation fork alive when the file restore fails, and says why", async () => {
    const world = forkWorld({ checkpoint: treeHash, restoreError: new Error("disk detached") });
    const outcome = await world.fork("u2", "two");
    expect(world.opened).toEqual(["forked-1"]);
    expect(outcome).toEqual({
      forked: true,
      note: "forked · file restore failed: disk detached",
    });
  });

  it("skips restoring when no checkpoint store is available", async () => {
    const opened: (string | undefined)[] = [];
    const trees: SessionTreePort = {
      load: async (sessionId) => ({ sessionId, roots: promptRoots(treeHash) }),
      setLabel: async () => {},
      fork: async () => "forked-1",
    };
    const outcome = await forkAtPrompt(
      trees,
      (sessionId) => opened.push(sessionId),
      undefined,
      "s1",
      "u2",
      "two",
    );
    expect(outcome).toEqual({ forked: true, note: "forked · files untouched" });
    expect(opened).toEqual(["forked-1"]);
  });

  it("forks at the chosen prompt's own entry after a flush and a compaction were replayed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keywork-backtrack-"));
    try {
      const store = await SessionStore.create(join(dir, "session.jsonl"), ".");
      await store.append(textMessage("user", "first"), undefined, "tree-first");
      await store.append(textMessage("assistant", "re: first"));
      await store.append(textMessage("user", memoryFlushPrompt));
      const flushReply = await store.append(textMessage("assistant", "nothing to keep"));
      const second = await store.append(textMessage("user", "second"), undefined, "tree-second");
      await store.append(textMessage("assistant", "re: second"));
      await store.appendCompaction({
        summary: "earlier work",
        firstKeptEntryId: second.id,
        tokensBefore: 9,
      });
      await store.append(textMessage("user", "third"), undefined, "tree-third");
      await store.append(textMessage("assistant", "re: third"));

      const forkedFrom: string[] = [];
      const restored: string[] = [];
      const trees: SessionTreePort = {
        load: async () => ({ sessionId: store.header.id, roots: store.tree() }),
        setLabel: async () => {},
        fork: async (_sessionId, entryId) => {
          forkedFrom.push(entryId);
          return "forked-1";
        },
      };
      const checkpoints: CheckpointsPort = {
        capture: async () => {},
        undo: async () => false,
        redo: async () => false,
        restoreTo: async (tree) => {
          restored.push(tree);
        },
      };
      const probe = new AppProbe({
        createPane: (id, notify, commands) => {
          const agent = new Agent({ provider: new MockProvider([]), history: store.messages() });
          const pane = new ConversationPane(id, agent, notify, undefined, commands, {
            ports: {
              forkAtPrompt: (promptId, draft) =>
                forkAtPrompt(trees, () => {}, checkpoints, store.header.id, promptId, draft),
            },
          });
          replaySession(store, agent.bus);
          return pane;
        },
      });
      expect(
        probe
          .model()
          ?.entries.filter((entry) => entry.kind === "user")
          .map((entry) => entry.text),
      ).toEqual(["earlier work", "second", "third"]);

      probe.keys("escape", "escape", "up", "enter");
      await probe.settled();

      expect(forkedFrom).toEqual([flushReply.id]);
      expect(restored).toEqual(["tree-second"]);
      expect(probe.model()?.entries.at(-1)).toEqual({
        kind: "info",
        text: "files put back to that point",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces the restore note quietly in the transcript after enter-fork", async () => {
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({ provider: new MockProvider([textTurn("re: one")]) });
        const pane = new ConversationPane(id, agent, notify, undefined, commands, {
          ports: {
            forkAtPrompt: async () => ({ forked: true, note: "files put back to that point" }),
          },
        });
        bindSessionLifecycle({
          pane,
          attachment: {
            id: "s1",
            history: [],
            replay: () => {},
            append: async () => ({ entryId: "u1" }),
          },
        });
        return pane;
      },
    });
    probe.type("one").keys("enter");
    await probe.settled();
    probe.keys("escape", "escape", "enter");
    await probe.settled();
    expect(probe.model()?.entries.at(-1)).toEqual({
      kind: "info",
      text: "files put back to that point",
    });
  });
});
