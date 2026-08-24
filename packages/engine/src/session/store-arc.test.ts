import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import { SessionStore } from "./store.ts";

const tempDirs: string[] = [];

async function sessionDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-store-arc-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionStore arc binding (PD9 · PD13)", () => {
  it("is unbound until an arc_binding entry lands", async () => {
    const store = await SessionStore.create(join(await sessionDir(), "s.jsonl"), ".");
    expect(store.arcBinding()).toBeUndefined();
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
      "arc_binding",
      "message",
      "arc_binding",
    ]);
  });

  it("releases the binding with an entry carrying no arc", async () => {
    const store = await SessionStore.create(join(await sessionDir(), "s.jsonl"), ".");
    await store.appendArcBinding("dock-v2");
    const released = await store.appendArcBinding(undefined);
    expect(released).not.toHaveProperty("arc");
    expect(store.arcBinding()).toBeUndefined();
  });

  it("follows the branch: a binding made on another branch never leaks in", async () => {
    const store = await SessionStore.create(join(await sessionDir(), "s.jsonl"), ".");
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
