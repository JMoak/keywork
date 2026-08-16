import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, SessionStore, textMessage } from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { persistNewMessages } from "./chat.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStore(): Promise<SessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-chat-"));
  tempDirs.push(dir);
  return SessionStore.create(join(dir, "session.jsonl"), dir);
}

describe("persistNewMessages", () => {
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
