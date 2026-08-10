import { Agent, MockProvider, type Tool, textTurn, toolCallTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { paletteFrame, paletteRowLimit } from "./app-core.ts";
import { BrowserPane } from "./browser-pane.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { FileModel } from "./file-model.ts";
import type { Chord } from "./keys.ts";
import type { Pane } from "./pane.ts";
import { AppProbe } from "./probe.ts";

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function paneIds(probe: AppProbe): string[] {
  return probe.snapshot().panes.map((pane) => pane.id);
}

function stubFilePane(id: string, path: string, handleKey?: (chord: Chord) => boolean): Pane {
  return {
    id,
    title: () => ` ${path} `,
    view: () => {
      throw new Error("probe panes are never rendered");
    },
    ...(handleKey !== undefined && { handleKey }),
  };
}

function dockedIds(probe: AppProbe): string[] {
  return probe
    .snapshot()
    .panes.filter((pane) => pane.docked)
    .map((pane) => pane.id);
}

describe("boot", () => {
  it("starts with a single focused pane", () => {
    const probe = new AppProbe();
    const snapshot = probe.snapshot();
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(snapshot.focused).toBe("session-1");
    expect(snapshot.panes[0]?.focused).toBe(true);
    expect(probe.exited).toBe(false);
  });
});

describe("split and sticky navigation", () => {
  it("splits twice from a single leader press", () => {
    const probe = new AppProbe().keys("ctrl+k", "s", "s");
    expect(paneIds(probe)).toEqual(["session-1", "session-2", "session-3"]);
    expect(probe.snapshot().focused).toBe("session-3");
    expect(probe.snapshot().leaderArmed).toBe(true);
  });

  it("traverses h/l/j/k in one sticky chain", () => {
    const probe = new AppProbe().keys("ctrl+k", "s", "s", "h");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.keys("l");
    expect(probe.snapshot().focused).toBe("session-2");
    probe.keys("j");
    expect(probe.snapshot().focused).toBe("session-3");
    probe.keys("k");
    expect(probe.snapshot().focused).toBe("session-2");
  });
});

describe("docking", () => {
  it("docks, stacks a second pane, undocks, and re-docks right", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.command("split");

    probe.keys("ctrl+k", "d");
    expect(probe.snapshot().dockSide).toBe("left");
    expect(dockedIds(probe)).toEqual(["session-3"]);

    probe.keys("l", "d");
    expect(dockedIds(probe)).toEqual(["session-3", "session-1"]);

    probe.keys("u");
    expect(dockedIds(probe)).toEqual(["session-3"]);
    expect(paneIds(probe)).toContain("session-1");

    probe.keys("shift+d");
    expect(probe.snapshot().dockSide).toBe("right");
  });
});

describe("zoom", () => {
  it("toggles zoom on the focused pane and back", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "z");
    expect(probe.snapshot().zoomed).toBe("session-2");
    probe.keys("z");
    expect(probe.snapshot().zoomed).toBeUndefined();
  });
});

describe("command palette", () => {
  it("opens, takes a query, and runs the top match on enter", () => {
    const probe = new AppProbe().keys("ctrl+p");
    expect(probe.snapshot().overlay).toBe("palette");

    probe.type("split");
    expect(probe.snapshot().paletteQuery).toBe("split");

    probe.keys("enter");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
  });

  it("closes on escape without running anything", () => {
    const probe = new AppProbe().keys("ctrl+p").type("split").keys("escape");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1"]);
  });
});

describe("slash commands", () => {
  it("/exit closes the focused pane while others remain", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.type("/exit").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.exited).toBe(false);
  });

  it("/exit from the last pane quits the app", () => {
    const probe = new AppProbe().type("/exit").keys("enter");
    expect(probe.exited).toBe(true);
  });

  it("/exit-all quits immediately from any pane", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.type("/exit-all").keys("enter");
    expect(probe.exited).toBe(true);
  });
});

describe("closing panes via keys", () => {
  it("closes one of several panes and keeps the app running", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "x");
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.exited).toBe(false);
  });

  it("quits from the last pane, matching /exit", () => {
    const probe = new AppProbe().keys("ctrl+k", "x");
    expect(probe.exited).toBe(true);
  });

  it("closing a busy pane interrupts its agent and detaches its transcript", async () => {
    const agents: Agent[] = [];
    const probe = new AppProbe({
      createPane: (id, notify, commands) => {
        const agent = new Agent({ provider: new MockProvider([textTurn("reply")]) });
        agents.push(agent);
        return new ConversationPane(id, agent, notify, undefined, commands);
      },
    });
    probe.command("split");
    probe.type("go").keys("enter");
    const closing = probe.model();
    expect(closing?.busy).toBe(true);
    const busyAgent = agents.find((agent) => agent.busy());
    expect(busyAgent).toBeDefined();

    probe.keys("ctrl+k", "x");

    expect(probe.exited).toBe(false);
    expect(paneIds(probe)).toEqual(["session-1"]);
    await waitFor(() => expect(busyAgent?.busy()).toBe(false));
    expect(closing?.entries).toEqual([{ kind: "user", text: "go" }]);
    expect(closing?.busy).toBe(false);
  });
});

describe("sticky chain boundaries", () => {
  it("disarms on a second ctrl+k instead of acting as leader k", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "s", "ctrl+k");
    expect(probe.snapshot().leaderArmed).toBe(false);
    expect(probe.snapshot().focused).toBe("session-3");
  });

  it("lets / start slash input after a sticky action instead of opening help", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "h", "/");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(probe.model()?.input).toBe("/");
  });

  it("still opens help from a fresh leader /", () => {
    const probe = new AppProbe().keys("ctrl+k", "/");
    expect(probe.snapshot().overlay).toBe("help");
  });
});

describe("splitting from a docked pane", () => {
  it("opens the new session into the main tree, not the dock", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+k", "d");
    expect(dockedIds(probe)).toEqual(["session-2"]);

    probe.keys("s");
    expect(dockedIds(probe)).toEqual(["session-2"]);
    expect(paneIds(probe)).toEqual(["session-1", "session-3", "session-2"]);
    expect(probe.snapshot().focused).toBe("session-3");
  });

  it("lands in the main area even when every pane is docked", () => {
    const probe = new AppProbe().keys("ctrl+k", "d");
    expect(dockedIds(probe)).toEqual(["session-1"]);

    probe.keys("s");
    expect(dockedIds(probe)).toEqual(["session-1"]);
    expect(paneIds(probe)).toEqual(["session-2", "session-1"]);
  });
});

describe("armed indicator expiry", () => {
  it("clears leaderArmed once the keymap's arm window lapses", () => {
    const probe = new AppProbe().keys("ctrl+k");
    expect(probe.snapshot().leaderArmed).toBe(true);

    probe.core.expireArmed(10_000);
    expect(probe.snapshot().leaderArmed).toBe(false);
  });
});

describe("jump commands", () => {
  it("lists a go-<session> entry for each unfocused pane and jumps on run", () => {
    const probe = new AppProbe();
    probe.command("split");
    const jump = probe.core.registry.search("go").find((entry) => entry.name.startsWith("go-"));
    expect(jump?.name).toBe("go-session-1");
    expect(probe.command("go-session-1")).toBe(true);
    expect(probe.snapshot().focused).toBe("session-1");
  });
});

describe("open file pane", () => {
  const fileProbe = () => new AppProbe({ createFilePane: (id, path) => stubFilePane(id, path) });

  it("/open <path> adds a file pane beside the session and focuses it", () => {
    const probe = fileProbe().type("/open src/app.ts").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1", "file-1"]);
    expect(probe.snapshot().focused).toBe("file-1");
    expect(probe.snapshot().panes[1]?.title).toBe("src/app.ts");
  });

  it("/open without a path does nothing", () => {
    const probe = fileProbe().type("/open").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1"]);
  });

  it("open is absent when no file pane factory is wired", () => {
    expect(new AppProbe().command("open src/app.ts")).toBe(false);
  });
});

describe("file browser", () => {
  const listing: Record<string, { name: string; kind: "file" | "dir" }[]> = {
    ".": [
      { name: "src", kind: "dir" },
      { name: "readme.md", kind: "file" },
    ],
    src: [{ name: "app.ts", kind: "file" }],
  };
  const browserProbe = () =>
    new AppProbe({
      createFilePane: (id, path) => stubFilePane(id, path),
      createBrowserPane: (id, root, notify, intents) =>
        new BrowserPane(id, root, notify, intents, async (path) => {
          const entries = listing[path];
          if (entries === undefined) throw new Error(`no such directory: ${path}`);
          return entries;
        }),
      isDirectory: (path) => listing[path] !== undefined,
    });

  it("/browse opens the browser docked left and focused", () => {
    const probe = browserProbe().type("/browse").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1", "browser-1"]);
    expect(dockedIds(probe)).toEqual(["browser-1"]);
    expect(probe.snapshot().dockSide).toBe("left");
    expect(probe.snapshot().focused).toBe("browser-1");
  });

  it("leader f summons the browser and refocuses it instead of duplicating", () => {
    const probe = browserProbe().keys("ctrl+k", "f");
    expect(paneIds(probe)).toEqual(["session-1", "browser-1"]);
    expect(probe.snapshot().focused).toBe("browser-1");
    probe.keys("ctrl+k", "l");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.keys("f");
    expect(probe.snapshot().focused).toBe("browser-1");
    expect(paneIds(probe)).toEqual(["session-1", "browser-1"]);
  });

  it("enter on a file opens it into the main area and keeps the browser docked", async () => {
    const probe = browserProbe().type("/browse").keys("enter");
    await probe.settled();
    probe.keys("j", "enter");
    expect(paneIds(probe)).toEqual(["session-1", "file-1", "browser-1"]);
    expect(probe.snapshot().focused).toBe("file-1");
    expect(dockedIds(probe)).toEqual(["browser-1"]);
    expect(probe.snapshot().panes.find((pane) => pane.id === "file-1")?.title).toBe("readme.md");
  });

  it("/open <dir> redirects to the browser instead of a file pane", async () => {
    const probe = browserProbe().type("/open src").keys("enter");
    await probe.settled();
    expect(paneIds(probe)).toEqual(["session-1", "browser-1"]);
    expect(dockedIds(probe)).toEqual(["browser-1"]);
    expect(probe.snapshot().panes.find((pane) => pane.id === "browser-1")?.title).toContain("src");
  });

  it("browse is absent when no browser factory is wired", () => {
    expect(new AppProbe().command("browse")).toBe(false);
  });
});

describe("pane resize", () => {
  it("grows and shrinks the focused pane from the leader chord", () => {
    const probe = new AppProbe();
    probe.command("split");
    const before = probe.rect("session-2").width;
    probe.keys("ctrl+k", "shift+.");
    expect(probe.rect("session-2").width).toBeGreaterThan(before);
    probe.keys("shift+,");
    expect(probe.rect("session-2").width).toBe(before);
  });

  it("resizes via the palette commands", () => {
    const probe = new AppProbe();
    probe.command("split");
    const before = probe.rect("session-2").width;
    expect(probe.command("grow")).toBe(true);
    expect(probe.rect("session-2").width).toBeGreaterThan(before);
    expect(probe.command("shrink")).toBe(true);
    expect(probe.rect("session-2").width).toBe(before);
  });
});

describe("mouse", () => {
  const modelFilePane = () => {
    const models = new Map<string, FileModel>();
    const probe = new AppProbe({
      createFilePane: (id, path) => {
        const model = new FileModel(process.cwd(), path, () => {});
        models.set(id, model);
        return stubFilePane(id, path, (chord) => model.handleKey(chord, 10));
      },
    });
    return { probe, models };
  };

  it("focuses the pane under a click", () => {
    const probe = new AppProbe();
    probe.command("split");
    const rect = probe.rect("session-1");
    probe.click(rect.x + 1, rect.y + 1);
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("wheel-scrolls the pane under the cursor without moving focus", () => {
    const { probe, models } = modelFilePane();
    probe.type("/open notes.txt").keys("enter");
    const session = probe.rect("session-1");
    probe.click(session.x + 1, session.y + 1);
    const file = probe.rect("file-1");
    probe.scroll(file.x + 1, file.y + 1, "down", 3);
    expect(models.get("file-1")?.scrollTop).toBe(3);
    expect(probe.snapshot().focused).toBe("session-1");
    probe.scroll(file.x + 1, file.y + 1, "up", 5);
    expect(models.get("file-1")?.scrollTop).toBe(0);
  });

  it("clamps huge wheel deltas to a bounded scroll", () => {
    const { probe, models } = modelFilePane();
    probe.type("/open notes.txt").keys("enter");
    const file = probe.rect("file-1");
    probe.scroll(file.x + 1, file.y + 1, "down", 10_000);
    expect(models.get("file-1")?.scrollTop).toBe(10);
  });

  it("moves the palette selection on hover, and arrows still win afterwards", () => {
    const probe = new AppProbe().keys("ctrl+p");
    const rows = Math.min(paletteRowLimit, probe.core.registry.search("").length);
    const frame = paletteFrame(probe.screen, rows);
    probe.hover(frame.x + 2, frame.firstRowY + 2);
    expect(probe.core.paletteIndex).toBe(2);
    probe.keys("down");
    expect(probe.core.paletteIndex).toBe(3);
  });

  it("runs the clicked palette row", () => {
    const probe = new AppProbe().keys("ctrl+p").type("split");
    const rows = Math.min(paletteRowLimit, probe.core.registry.search("split").length);
    const frame = paletteFrame(probe.screen, rows);
    probe.click(frame.x + 2, frame.firstRowY);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
  });

  it("closes the palette on an outside click without running anything", () => {
    const probe = new AppProbe().keys("ctrl+p").type("split");
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1"]);
  });

  it("closes the help overlay on an outside click", () => {
    const probe = new AppProbe().keys("ctrl+k", "/");
    expect(probe.snapshot().overlay).toBe("help");
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
  });

  it("ignores clicks and scrolls when no pane is under the cursor", () => {
    const probe = new AppProbe();
    probe.click(500, 500).scroll(500, 500, "down").hover(500, 500);
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.exited).toBe(false);
  });
});

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
    await waitFor(() => expect(probe.snapshot().notice).toBe("files restored"));

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

    expect(probe.model()?.entries).toContainEqual({
      kind: "tool",
      text: "✗ scribble — declined by user",
      failed: true,
    });
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
