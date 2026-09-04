import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import { SessionStore } from "./store.ts";

const sessionDir = scratchDirs("keywork-store-binding-");

async function freshStore(): Promise<SessionStore> {
  return SessionStore.create(join(await sessionDir(), "s.jsonl"), ".");
}

describe("SessionStore arc binding (PD9 · PD13)", () => {
  it("is unbound until a binding entry lands", async () => {
    const store = await freshStore();
    expect(store.arcBinding()).toBeUndefined();
    expect(store.binding()).toEqual({});
  });

  it("persists the binding as a session entry and resolves the last one on the active path", async () => {
    const file = join(await sessionDir(), "s.jsonl");
    const store = await SessionStore.create(file, ".");
    await store.appendArcBinding("dock-v2");
    await store.append(textMessage("user", "hi"));
    await store.appendArcBinding("infra");
    expect(store.arcBinding()).toBe("infra");

    const reopened = await SessionStore.open(file);
    expect(reopened.arcBinding()).toBe("infra");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).type)).toEqual([
      "session",
      "binding",
      "message",
      "binding",
    ]);
  });

  it("releases the binding with an entry carrying a null arc", async () => {
    const store = await freshStore();
    await store.appendArcBinding("dock-v2");
    const released = await store.appendArcBinding(undefined);
    expect(released).toMatchObject({ arc: null });
    expect(released).not.toHaveProperty("bot");
    expect(store.arcBinding()).toBeUndefined();
  });

  it("follows the branch: a binding made on another branch never leaks in", async () => {
    const store = await freshStore();
    await store.appendArcBinding("dock-v2");
    const prompt = await store.append(textMessage("user", "first"));
    await store.appendArcBinding("infra");
    store.branch(prompt.id);
    expect(store.arcBinding()).toBe("dock-v2");
  });

  it("forks inherit the binding because the clone carries the active path", async () => {
    const dir = await sessionDir();
    const store = await SessionStore.create(join(dir, "s.jsonl"), ".");
    await store.appendArcBinding("dock-v2");
    await store.append(textMessage("user", "first"));
    const fork = await store.clone(join(dir, "fork.jsonl"));
    expect(fork.arcBinding()).toBe("dock-v2");
    expect((await SessionStore.open(fork.file)).arcBinding()).toBe("dock-v2");
  });
});

describe("SessionStore bot binding (PD21.4 · B9)", () => {
  it("binds and releases a bot on its own axis without touching the arc", async () => {
    const store = await freshStore();
    await store.appendArcBinding("dock-v2");
    await store.appendBotBinding("scout");
    expect(store.binding()).toEqual({ arc: "dock-v2", bot: "scout" });

    await store.appendBotBinding(undefined);
    expect(store.binding()).toEqual({ arc: "dock-v2" });
    expect(store.botBinding()).toBeUndefined();
  });

  it("an arc change leaves the bot bound and an arc release leaves the bot bound", async () => {
    const store = await freshStore();
    await store.appendBotBinding("scout");
    await store.appendArcBinding("infra");
    expect(store.binding()).toEqual({ arc: "infra", bot: "scout" });
    await store.appendArcBinding(undefined);
    expect(store.binding()).toEqual({ bot: "scout" });
  });

  it("writes one delta entry per change, never a snapshot", async () => {
    const store = await freshStore();
    await store.appendArcBinding("dock-v2");
    const entry = await store.appendBotBinding("scout");
    expect(entry).toMatchObject({ type: "binding", bot: "scout" });
    expect(entry).not.toHaveProperty("arc");
  });

  it("survives exit and resume, and rides into forks with the arc", async () => {
    const dir = await sessionDir();
    const store = await SessionStore.create(join(dir, "s.jsonl"), ".");
    await store.appendBotBinding("scout");
    await store.appendArcBinding("dock-v2");
    await store.append(textMessage("user", "first"));

    expect((await SessionStore.open(store.file)).binding()).toEqual({
      arc: "dock-v2",
      bot: "scout",
    });
    const fork = await store.clone(join(dir, "fork.jsonl"));
    expect(fork.binding()).toEqual({ arc: "dock-v2", bot: "scout" });
  });

  it("an unbound session never writes a binding entry", async () => {
    const store = await freshStore();
    await store.append(textMessage("user", "hi"));
    expect(store.entries().map((entry) => entry.type)).toEqual(["message"]);
  });
});

describe("legacy arc_binding entries", () => {
  it("read as binding entries so sessions written before B9 keep their arc", async () => {
    const file = join(await sessionDir(), "legacy.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "legacy-1",
      timestamp: "2026-08-21T09:00:00.000Z",
      cwd: ".",
    };
    const bound = {
      type: "arc_binding",
      id: "e1",
      parentId: null,
      timestamp: "2026-08-21T09:00:01.000Z",
      arc: "dock-v2",
    };
    const released = { type: "arc_binding", id: "e2", parentId: "e1", timestamp: "" };
    await writeFile(
      file,
      [header, bound, released].map((line) => `${JSON.stringify(line)}\n`).join(""),
    );

    const store = await SessionStore.open(file);
    expect(store.entries().map((entry) => entry.type)).toEqual(["binding", "binding"]);
    expect(store.entries()[0]).toMatchObject({ type: "binding", arc: "dock-v2" });
    expect(store.entries()[1]).toMatchObject({ type: "binding", arc: null });
    expect(store.binding()).toEqual({});
    store.branch("e1");
    expect(store.arcBinding()).toBe("dock-v2");
  });
});
