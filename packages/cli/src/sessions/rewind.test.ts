import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Checkpoints, messageText, type SessionStore, textMessage } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { sessionPort } from "./ports.ts";
import { findSession } from "./store.ts";

const tempDir = scratchDirs("keywork-sessions-rewind-");

async function storeOf(dir: string, id: string | undefined): Promise<SessionStore> {
  const store = await findSession(dir, id ?? "");
  if (store === undefined) throw new Error(`no session ${id}`);
  return store;
}

describe("rewindBefore", () => {
  it("moves the leaf above the prompt and back again without touching the file", async () => {
    const dir = await tempDir();
    const tags = ["tree-one", "tree-two"];
    const port = sessionPort(dir, ".", { checkpointTag: () => tags.shift() });
    const attachment = await port.create();
    await attachment?.append(textMessage("user", "first"));
    await attachment?.append(textMessage("assistant", "one"));
    const prompt = await attachment?.append(textMessage("user", "second"));
    await attachment?.append(textMessage("assistant", "two"));

    const rewound = attachment?.rewindBefore?.(prompt?.entryId ?? "");

    expect(rewound?.checkpoint).toBe("tree-two");
    expect(rewound?.history.map(messageText)).toEqual(["first", "one"]);
    expect(rewound?.restore().map(messageText)).toEqual(["first", "one", "second", "two"]);
  });

  it("branches the next prompt from the rewound point and keeps the old turn in the tree", async () => {
    const dir = await tempDir();
    const port = sessionPort(dir, ".");
    const attachment = await port.create();
    const prompt = await attachment?.append(textMessage("user", "draft"));
    await attachment?.append(textMessage("assistant", "reply"));

    attachment?.rewindBefore?.(prompt?.entryId ?? "");
    await attachment?.append(textMessage("user", "edited"));

    const reopened = await storeOf(dir, attachment?.id);
    expect(reopened.messages().map(messageText)).toEqual(["edited"]);
    expect(reopened.entries()).toHaveLength(3);
  });

  it("refuses anything but a user prompt", async () => {
    const dir = await tempDir();
    const port = sessionPort(dir, ".");
    const attachment = await port.create();
    await attachment?.append(textMessage("user", "hi"));
    const reply = await attachment?.append(textMessage("assistant", "hello"));

    expect(attachment?.rewindBefore?.(reply?.entryId ?? "")).toBeUndefined();
    expect(attachment?.rewindBefore?.("missing")).toBeUndefined();
  });
});

describe("the session's own files", () => {
  async function agentTurnBesideMine() {
    const root = await tempDir();
    const worktree = join(root, "project");
    await mkdir(worktree);
    await writeFile(join(worktree, "mine.md"), "mine\n");
    const checkpoints = await Checkpoints.open({ worktree, gitDir: join(root, "shadow") });
    const port = sessionPort(join(root, "sessions"), worktree, {
      checkpointTag: () => checkpoints.takeTurnTag(),
      turnTrees: checkpoints,
    });
    const attachment = await port.create();
    if (attachment === undefined) throw new Error("no session was created");
    const prompt = await attachment.openTurn?.(textMessage("user", "write the agent file"));
    await checkpoints.captureTree();
    await writeFile(join(worktree, "agent.ts"), "export const agent = 1;\n");
    await attachment.append(textMessage("assistant", "wrote it"));
    await attachment.settleTurn?.(prompt?.entryId ?? "");
    await writeFile(join(worktree, "mine.md"), "mine, edited\n");
    return { port, attachment, promptId: prompt?.entryId ?? "" };
  }

  it("names what the session's turns changed from a prompt on, never the person's own edits", async () => {
    const { attachment, promptId } = await agentTurnBesideMine();

    expect(await attachment.sessionPathsFrom?.(promptId)).toEqual(["agent.ts"]);
    expect(await attachment.sessionPathsFrom?.("missing")).toEqual([]);
  });

  it("journals the paths an undo put back, so a reopened session redoes only those", async () => {
    const { port, attachment, promptId } = await agentTurnBesideMine();
    const rewound = attachment.rewindBefore?.(promptId);

    await rewound?.journal?.({ restoredTo: "tree-a", redoTree: "tree-b", paths: ["agent.ts"] });
    const reopened = await port.open(attachment.id);

    expect(reopened?.stagedRewind).toMatchObject({ redoFiles: "tree-b", redoPaths: ["agent.ts"] });
  });
});
