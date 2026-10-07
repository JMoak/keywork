import { Agent, type Message, MockProvider, messageText, textTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import type { CheckpointsPort } from "./fork.ts";
import { AppProbe } from "./probe.ts";
import { bindSessionLifecycle, type SessionAttachment } from "./session-attachment.ts";
import { keyworkNight } from "./theme.ts";

interface TreeEntry {
  id: string;
  parentId: string | null;
  message: Message;
  checkpoint: string | undefined;
}

class TreeSession {
  readonly entries: TreeEntry[] = [];
  leaf: string | null = null;
  nextCheckpoint: string | undefined;

  attachment(): SessionAttachment {
    return {
      id: "sess-1",
      history: [],
      replay: () => {},
      append: async (message) => this.append(message),
      rewindBefore: (promptId) => {
        const prompt = this.entries.find((entry) => entry.id === promptId);
        if (prompt === undefined) return undefined;
        const leaf = this.leaf;
        this.leaf = prompt.parentId;
        return {
          checkpoint: prompt.checkpoint,
          history: this.activeMessages(),
          restore: () => {
            this.leaf = leaf;
            return this.activeMessages();
          },
        };
      },
    };
  }

  activeMessages(): Message[] {
    const path: Message[] = [];
    for (let id = this.leaf; id !== null; ) {
      const entry = this.entries.find((candidate) => candidate.id === id);
      if (entry === undefined) break;
      path.unshift(entry.message);
      id = entry.parentId;
    }
    return path;
  }

  private append(message: Message): { entryId: string } {
    const id = `e${this.entries.length + 1}`;
    const checkpoint = message.role === "user" ? this.nextCheckpoint : undefined;
    this.entries.push({ id, parentId: this.leaf, message, checkpoint });
    this.leaf = id;
    return { entryId: id };
  }
}

class FileWorld implements CheckpointsPort {
  files: Record<string, string> = {};
  private readonly trees = new Map<string, Record<string, string>>();

  async snapshot(): Promise<string> {
    const tree = `t${this.trees.size + 1}`;
    this.trees.set(tree, { ...this.files });
    return tree;
  }

  async restoreTo(tree: string): Promise<void> {
    this.files = { ...(this.trees.get(tree) ?? {}) };
  }

  async capture(): Promise<void> {}

  async undo(): Promise<boolean> {
    return false;
  }

  async redo(): Promise<boolean> {
    return false;
  }
}

function undoProbe() {
  const session = new TreeSession();
  const world = new FileWorld();
  let agent: Agent | undefined;
  const probe = new AppProbe({
    undo: world,
    createPane: (id, notify, commands) => {
      const provider = new MockProvider([textTurn("made it v2"), textTurn("made it v3")]);
      const first = new Agent({ provider });
      agent = first;
      const pane = new ConversationPane(id, first, notify, undefined, commands);
      bindSessionLifecycle({
        pane,
        attachment: session.attachment(),
        checkpoints: world,
        rebuild: (history) => {
          agent = new Agent({ provider, bus: first.bus, history });
          return agent;
        },
      });
      pane.sessionId = "sess-1";
      return pane;
    },
  });
  const pane = probe.core.panes.get("session-1") as ConversationPane;
  const model = pane.model;
  const titleRow = (): string => titleTextOf(pane);
  const agentHistory = (): string[] => agent?.history().map(messageText) ?? [];
  return { probe, session, world, model, titleRow, agentHistory };
}

async function promptThatEdits(world: FileWorld, session: TreeSession, probe: AppProbe) {
  world.files = { "a.txt": "v1" };
  session.nextCheckpoint = await world.snapshot();
  world.files = { "a.txt": "v2" };
  probe.type("make it v2").keys("enter");
  await probe.settled();
}

describe("/undo stages the last prompt", () => {
  it("walks undo, edit, resubmit: files rolled back, prompt edited, new turn becomes the leaf", async () => {
    const { probe, session, world, model, titleRow, agentHistory } = undoProbe();
    await promptThatEdits(world, session, probe);
    const original = session.leaf;

    probe.type("/undo").keys("enter");
    await model.lastUndo;

    expect(world.files).toEqual({ "a.txt": "v1" });
    expect(model.input).toBe("make it v2");
    expect(model.entries.some((entry) => entry.kind === "user")).toBe(false);
    expect(model.undoStaged()).toBe(true);
    expect(titleRow()).toContain("undo staged");
    expect(session.leaf).toBeNull();
    expect(agentHistory()).toEqual([]);

    probe.keys("end").type(", then v3").keys("enter");
    await probe.settled();

    expect(model.undoStaged()).toBe(false);
    expect(titleRow()).not.toContain("undo staged");
    expect(session.activeMessages().map(messageText)).toEqual([
      "make it v2, then v3",
      "made it v3",
    ]);
    expect(session.entries).toHaveLength(4);
    expect(session.leaf).not.toBe(original);
    expect(agentHistory()).toEqual(["make it v2, then v3", "made it v3"]);
  });

  it("walks undo then /redo: files, turn and leaf all come back", async () => {
    const { probe, session, world, model, titleRow, agentHistory } = undoProbe();
    await promptThatEdits(world, session, probe);
    const original = session.leaf;

    probe.type("/undo").keys("enter");
    await model.lastUndo;
    probe.keys("ctrl+c").type("/redo").keys("enter");
    await model.lastUndo;

    expect(world.files).toEqual({ "a.txt": "v2" });
    expect(session.leaf).toBe(original);
    expect(model.undoStaged()).toBe(false);
    expect(titleRow()).not.toContain("undo staged");
    expect(model.input).toBe("");
    expect(model.entries.filter((entry) => entry.kind !== "info")).toEqual([
      expect.objectContaining({ kind: "user", text: "make it v2" }),
      { kind: "assistant", text: "made it v2" },
    ]);
    expect(agentHistory()).toEqual(["make it v2", "made it v2"]);
  });

  it("falls back to the file undo when there is no prompt to take back", async () => {
    let fileUndos = 0;
    const probe = new AppProbe({
      script: [],
      undo: {
        undo: async () => {
          fileUndos += 1;
          return true;
        },
        redo: async () => false,
      },
    });

    probe.type("/undo").keys("enter");
    await probe.settled();

    expect(fileUndos).toBe(1);
  });
});

function titleTextOf(pane: ConversationPane): string {
  const view = pane.view({ theme: keyworkNight, focused: true, width: 132, height: 20 });
  const children = (view as { children?: Array<{ props?: { content?: unknown } }> }).children ?? [];
  const row = children.find((child) => typeof child.props?.content === "object");
  const chunks = (row?.props?.content as { chunks?: Array<{ text: string }> })?.chunks ?? [];
  return chunks.map((chunk) => chunk.text).join("");
}
