import {
  Agent,
  type Message,
  MockProvider,
  messageText,
  type TurnDelta,
  type TurnSettlement,
  textMessage,
  textTurn,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import type { Pane } from "./pane.ts";
import { AppProbe } from "./probe.ts";
import {
  type AfterTurn,
  bindSessionLifecycle,
  type Compactor,
  type SessionAttachment,
} from "./session-attachment.ts";
import { waitFor } from "./testing/index.ts";
import { dockedIds, dockOf, mustParse, paneIds, stubFilePane } from "./testing/workflow-probe.ts";
import { parseWorkspaceState } from "./workspace-state.ts";

describe("workspace persistence", () => {
  const describableFactories = () => ({
    createFilePane: (id: string, path: string): Pane => ({
      ...stubFilePane(id, path),
      describe: () => ({ kind: "file", path }),
    }),
    createBrowserPane: (id: string, root: string): Pane => ({
      ...stubFilePane(id, root),
      describe: () => ({ kind: "browser", root }),
    }),
  });

  const savedState = (probe: AppProbe): unknown =>
    JSON.parse(JSON.stringify(probe.workspaceState()));

  function buildWorkspace(): AppProbe {
    const probe = new AppProbe(describableFactories());
    probe.command("split");
    probe.keys("ctrl+k", "shift+.", "shift+.", "escape");
    probe.command("browse");
    probe.command("open notes.md");
    (probe.core.panes.get("session-1") as ConversationPane).sessionId = "sess-a";
    (probe.core.panes.get("session-2") as ConversationPane).sessionId = "sess-b";
    probe.core.layout.focus("session-2");
    return probe;
  }

  it("restores geometry, panes, dock, and focus into a fresh core", () => {
    const first = buildWorkspace();
    const state = mustParse(savedState(first));

    const resumed: string[] = [];
    const second = new AppProbe({
      ...describableFactories(),
      createPane: (id, notify, commands, resumeSessionId) => {
        if (resumeSessionId !== undefined) resumed.push(`${id}=${resumeSessionId}`);
        const pane = new ConversationPane(id, undefined, notify, undefined, commands);
        pane.sessionId = resumeSessionId;
        return pane;
      },
      restoreWorkspace: state,
    });

    expect(paneIds(second).sort()).toEqual(paneIds(first).sort());
    expect(second.snapshot().focused).toBe("session-2");
    expect(dockedIds(second)).toEqual(dockedIds(first));
    for (const id of dockedIds(first)) expect(dockOf(second, id)).toBe(dockOf(first, id));
    for (const id of paneIds(first)) expect(second.rect(id)).toEqual(first.rect(id));
    expect(resumed.sort()).toEqual(["session-1=sess-a", "session-2=sess-b"]);

    second.command("split");
    expect(paneIds(second)).toContain("session-3");
  });

  it("persists browser panes as root only; expansion state is absent by design", () => {
    const probe = new AppProbe(describableFactories());
    probe.command("browse src");
    const browser = probe.workspaceState().panes.find((pane) => pane.kind === "browser");
    expect(browser).toEqual({ id: "browser-1", kind: "browser", root: "src" });
  });

  it("skips panes whose revival fails and keeps the rest", () => {
    const state = mustParse(savedState(buildWorkspace()));
    const second = new AppProbe({
      ...describableFactories(),
      createFilePane: () => {
        throw new Error("file vanished");
      },
      restoreWorkspace: state,
    });
    expect(paneIds(second)).not.toContain("file-1");
    expect(paneIds(second)).toEqual(
      expect.arrayContaining(["session-1", "session-2", "browser-1"]),
    );
  });

  it("starts clean when nothing survives restore", () => {
    const first = new AppProbe(describableFactories());
    first.command("open notes.md");
    first.core.layout.focus("session-1");
    first.command("exit");
    const state = mustParse(savedState(first));
    expect(state.panes).toEqual([{ id: "file-1", kind: "file", path: "notes.md" }]);

    const second = new AppProbe({ restoreWorkspace: state });
    expect(paneIds(second)).toEqual(["session-1"]);
  });

  it("saves on layout changes but not on mere typing", () => {
    const saves: string[] = [];
    const probe = new AppProbe({
      saveWorkspace: (state) => saves.push(JSON.stringify(state)),
    });
    expect(saves).toHaveLength(1);
    probe.command("split");
    expect(saves).toHaveLength(2);
    probe.type("hello");
    expect(saves).toHaveLength(2);
    probe.keys("ctrl+k", "h");
    expect(saves).toHaveLength(3);
    expect(new Set(saves).size).toBe(3);
  });

  it("corrupt saved payloads are rejected before they reach the core", () => {
    expect(parseWorkspaceState("{ not json at all")).toBeUndefined();
    expect(parseWorkspaceState({ version: 99, layout: {}, panes: [] })).toBeUndefined();
  });
});

describe("session after-turn lifecycle", () => {
  interface RecordedAttachment extends SessionAttachment {
    appended: Message[];
  }

  function recordedAttachment(id: string): RecordedAttachment {
    const appended: Message[] = [];
    return {
      id,
      history: [],
      appended,
      replay: () => {},
      append: async (message) => {
        appended.push(message);
        return undefined;
      },
    };
  }

  function lifecycleProbe(options: {
    turns: TurnDelta[][];
    afterTurn?: AfterTurn;
    compact?: Compactor;
  }) {
    const attachment = recordedAttachment("sess-1");
    const rebuilt: Agent[] = [];
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const provider = new MockProvider(options.turns);
        const agent = new Agent({ provider });
        const pane = new ConversationPane(id, agent, notify, undefined, commands);
        bindSessionLifecycle({
          pane,
          attachment,
          ...(options.afterTurn !== undefined && { afterTurn: options.afterTurn }),
          ...(options.compact !== undefined && { compact: options.compact }),
          rebuild: (history) => {
            const next = new Agent({ provider, bus: agent.bus, history });
            rebuilt.push(next);
            return next;
          },
        });
        pane.sessionId = attachment.id;
        return pane;
      },
    });
    return { probe, attachment, rebuilt };
  }

  it("persists turn messages, then joins flush messages into store and agent context", async () => {
    const flushMessages = [
      textMessage("user", "FLUSH-PROMPT"),
      textMessage("assistant", "FLUSH-REPLY"),
    ];
    const seen: string[] = [];
    const { probe, attachment, rebuilt } = lifecycleProbe({
      turns: [textTurn("first reply"), textTurn("second reply")],
      afterTurn: async ({ sessionId, history }) => {
        seen.push(`${sessionId}:${history.length}`);
        if (seen.length > 1) return undefined;
        for (const message of flushMessages) await attachment.append(message);
        return settlement([...history, ...flushMessages]);
      },
    });
    probe.type("hi").keys("enter");
    await probe.settled();

    expect(seen).toEqual(["sess-1:2"]);
    expect(attachment.appended.map((message) => messageText(message))).toEqual([
      "hi",
      "first reply",
      "FLUSH-PROMPT",
      "FLUSH-REPLY",
    ]);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.history()).toHaveLength(4);
    expect(probe.model()?.entries.some((entry) => entry.text.includes("FLUSH"))).toBe(false);

    probe.type("again").keys("enter");
    await probe.settled();
    expect(probe.model()?.entries.at(-1)).toEqual({ kind: "assistant", text: "second reply" });
    expect(attachment.appended.map((message) => messageText(message)).slice(4)).toEqual([
      "again",
      "second reply",
    ]);
    expect(rebuilt[0]?.history()).toHaveLength(6);
  });

  it("keeps the turn open until the after-turn hook settles", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { probe } = lifecycleProbe({
      turns: [textTurn("reply")],
      afterTurn: async () => {
        await gate;
        return undefined;
      },
    });
    probe.type("hi").keys("enter");
    await waitFor(() =>
      expect(probe.model()?.entries.at(-1)).toEqual({ kind: "assistant", text: "reply" }),
    );
    expect(probe.model()?.busy).toBe(true);
    release();
    await probe.settled();
    expect(probe.model()?.busy).toBe(false);
  });

  it("surfaces an after-turn failure and keeps the pane usable", async () => {
    const { probe } = lifecycleProbe({
      turns: [textTurn("first"), textTurn("second")],
      afterTurn: async () => {
        throw new Error("flush pipeline broke");
      },
    });
    probe.type("one").keys("enter");
    await probe.settled();
    expect(probe.model()?.entries).toContainEqual({ kind: "error", text: "flush pipeline broke" });
    expect(probe.model()?.busy).toBe(false);

    probe.type("two").keys("enter");
    await probe.settled();
    expect(probe.model()?.entries).toContainEqual({ kind: "assistant", text: "second" });
  });

  it("posts settlement notices and rebuilds on the compacted history", async () => {
    const summary = textMessage("user", "## Goal\nfolded");
    const { probe, rebuilt } = lifecycleProbe({
      turns: [textTurn("first reply"), textTurn("second reply")],
      afterTurn: async ({ history }) =>
        history.length >= 4
          ? {
              history: [summary, ...history.slice(-2)],
              notices: ["compacted 1k tokens into a summary · context now 200 of 2k"],
              flushed: [],
              compacted: undefined,
            }
          : undefined,
    });
    probe.type("one").keys("enter");
    await probe.settled();
    expect(rebuilt).toHaveLength(0);

    probe.type("two").keys("enter");
    await probe.settled();
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.history().map((message) => messageText(message))).toEqual([
      "## Goal\nfolded",
      "two",
      "second reply",
    ]);
    expect(probe.model()?.entries.at(-1)).toEqual({
      kind: "info",
      text: "compacted 1k tokens into a summary · context now 200 of 2k",
    });
  });

  it("/compact runs the compactor while the pane is busy, then applies its settlement", async () => {
    const requests: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { probe, rebuilt } = lifecycleProbe({
      turns: [textTurn("reply")],
      compact: async ({ history }, instructions) => {
        requests.push(instructions);
        await gate;
        return settlement(
          [textMessage("user", "summary"), ...history.slice(-1)],
          ["compacted 3 tokens into a summary · context now 1 of 2k"],
        );
      },
    });
    probe.type("hello").keys("enter");
    await probe.settled();

    probe.type("/compact keep the file names").keys("enter");
    await waitFor(() => expect(requests).toEqual(["keep the file names"]));
    expect(probe.model()?.busy).toBe(true);
    release();
    await probe.settled();
    expect(probe.model()?.busy).toBe(false);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.history().map((message) => messageText(message))).toEqual([
      "summary",
      "reply",
    ]);
    expect(probe.model()?.entries.at(-1)?.text).toContain("compacted 3 tokens");
  });

  it("/compact without a compactor says so instead of hanging", async () => {
    const { probe } = lifecycleProbe({ turns: [] });
    probe.type("/compact").keys("enter");
    await probe.settled();
    expect(probe.model()?.entries.at(-1)).toEqual({
      kind: "info",
      text: "can't compact · no session store",
    });
  });

  function settlement(
    history: readonly Message[],
    notices: readonly string[] = [],
  ): TurnSettlement {
    return { history, notices, flushed: [], compacted: undefined };
  }
});
