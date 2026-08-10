import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Message, SessionStore, textMessage } from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { persistNewMessages, startMcpRegistry } from "./chat.ts";

const fixtureServerPath = fileURLToPath(
  new URL("../../engine/src/mcp/fixture-server.ts", import.meta.url),
);

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

describe("startMcpRegistry", () => {
  it("returns nothing when no servers are configured", () => {
    expect(startMcpRegistry(undefined)).toBeUndefined();
    expect(startMcpRegistry({})).toBeUndefined();
  });

  it("starts configured servers and stops them cleanly", async () => {
    const registry = startMcpRegistry({
      fixture: {
        transport: "stdio",
        command: process.execPath,
        args: [fixtureServerPath, "basic"],
      },
    });
    expect(registry).toBeDefined();
    if (registry === undefined) return;
    try {
      expect(registry.tools().map((tool) => tool.name)).toContain("mcp_tool_search");
      const deadline = Date.now() + 10_000;
      while (registry.status()[0]?.state !== "connected") {
        if (Date.now() > deadline) throw new Error("fixture server never connected");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(registry.status()[0]).toMatchObject({ name: "fixture", toolCount: 2 });
    } finally {
      await registry.stop();
    }
    expect(registry.status()[0]?.state).toBe("down");
  });
});
