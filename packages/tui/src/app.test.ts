import { Agent, MockProvider, toolCallTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import { Animator } from "./motion.ts";
import type { Pane } from "./pane.ts";
import { AppProbe } from "./probe.ts";
import { resolveTheme } from "./theme.ts";
import type { WorkspaceState } from "./workspace-state.ts";

function countingPane(id: string, describes: string[]): Pane {
  return {
    id,
    title: () => id,
    view: () => {
      throw new Error("never rendered");
    },
    describe: () => {
      describes.push(id);
      return { kind: "memory" };
    },
  };
}

describe("resuming a session with no attachment", () => {
  it("posts a notice and opens no pane when the factory refuses the resume", () => {
    const probe = new AppProbe({
      createPane: (id, notify, commands, resumeSessionId) =>
        resumeSessionId === undefined
          ? new ConversationPane(id, undefined, notify, undefined, commands)
          : undefined,
    });
    probe.core.intents.openSession("gone-1");
    expect(probe.snapshot().panes.map((pane) => pane.id)).toEqual(["session-1"]);
    expect(probe.snapshot().focused).toBe("session-1");
    expect(probe.snapshot().notice).toBe(
      "can't open session gone-1 · its store is missing or unreadable",
    );
    probe.command("split");
    expect(probe.snapshot().panes.map((pane) => pane.id)).toEqual(["session-1", "session-2"]);
  });
});

describe("restoring a workspace", () => {
  function restoredState(): WorkspaceState {
    return {
      version: 2,
      layout: {
        tree: {
          kind: "split",
          orientation: "row",
          ratio: 0.5,
          first: { kind: "leaf", id: "session-1" },
          second: { kind: "leaf", id: "file-1" },
        },
        focused: "session-1",
      },
      panes: [
        { id: "session-1", kind: "conversation" },
        { id: "file-1", kind: "file", path: "notes.md" },
      ],
    };
  }

  it("drops a pane whose factory throws, closes its slot and says so", () => {
    const probe = new AppProbe({
      restoreWorkspace: restoredState(),
      createFilePane: () => {
        throw new Error("unreadable");
      },
    });
    expect(probe.snapshot().panes.map((pane) => pane.id)).toEqual(["session-1"]);
    expect(probe.snapshot().notice).toBe("couldn't restore 1 pane · file-1");
  });

  it("numbers new panes after the restored ones", () => {
    const probe = new AppProbe({
      restoreWorkspace: restoredState(),
      createFilePane: (id) => countingPane(id, []),
    });
    probe.command("split");
    expect(probe.snapshot().panes.map((pane) => pane.id)).toEqual([
      "session-1",
      "session-2",
      "file-1",
    ]);
  });
});

describe("workspace capture", () => {
  it("skips the capture on pointer moves and keys that change nothing persisted", () => {
    const describes: string[] = [];
    const saves: WorkspaceState[] = [];
    const probe = new AppProbe({
      createMemoryPane: (id) => countingPane(id, describes),
      saveWorkspace: (state) => saves.push(state),
    });
    probe.command("memory");
    const describedAfterOpen = describes.length;
    const savesAfterOpen = saves.length;
    for (let step = 0; step < 25; step += 1) probe.hover(5 + step, 5);
    probe.keys("ctrl+p").type("spl").keys("escape");
    expect(describes.length).toBe(describedAfterOpen);
    expect(saves.length).toBe(savesAfterOpen);
    probe.keys("ctrl+k", "l");
    expect(describes.length).toBe(describedAfterOpen + 1);
    expect(saves.length).toBe(savesAfterOpen + 1);
  });

  it("persists again when a pane's descriptor changes behind a repaint", () => {
    const saves: WorkspaceState[] = [];
    let root = "src";
    let notify = (): void => {};
    const probe = new AppProbe({
      createBrowserPane: (id, _root, paneNotify) => {
        notify = paneNotify;
        return {
          id,
          title: () => id,
          view: () => {
            throw new Error("never rendered");
          },
          describe: () => ({ kind: "browser", root }),
        };
      },
      saveWorkspace: (state) => saves.push(state),
    });
    probe.command("browse");
    const before = saves.length;
    notify();
    expect(saves.length).toBe(before);
    root = "src/deeper";
    notify();
    expect(saves.length).toBe(before + 1);
    expect(saves.at(-1)?.panes.find((pane) => pane.kind === "browser")).toEqual({
      id: "browser-1",
      kind: "browser",
      root: "src/deeper",
    });
  });
});

describe("closing a pane mid-animation", () => {
  it("settles its motion regions so nothing animates into a dead pane", async () => {
    const animator = new Animator({ schedule: () => () => {} });
    const probe = new AppProbe({
      createPane: (id, notify) => {
        const provider = new MockProvider([
          toolCallTurn({ type: "tool-call", callId: "c1", name: "scribble", arguments: {} }),
        ]);
        const agent = new Agent({
          provider,
          tools: [
            {
              name: "scribble",
              description: "writes",
              parameters: { type: "object" },
              mutates: true,
              execute: async () => "wrote",
            },
          ],
        });
        return new ConversationPane(id, agent, notify, undefined, undefined, { animator });
      },
    });
    probe.command("split");
    probe.type("go").keys("enter");
    const pane = probe.core.panes.get("session-2");
    for (let tick = 0; tick < 20 && probe.model("session-2")?.pendingAsk === undefined; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    pane?.view({ theme: resolveTheme(), focused: true, width: 60, height: 20 });
    expect(animator.moving).toBe(true);
    probe.command("exit");
    expect(animator.moving).toBe(false);
  });
});
