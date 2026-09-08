import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import { SessionStore } from "./store.ts";

const tempDirs: string[] = [];

async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-store-thinking-"));
  tempDirs.push(dir);
  return join(dir, "session.jsonl");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionStore thinking level (G4)", () => {
  it("has no level until a change is recorded", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    expect(store.thinkingLevel()).toBeUndefined();
  });

  it("records the switch as a thinking_level_change entry and resolves the last one on the active path", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    await store.appendThinkingLevelChange("on");
    const prompt = await store.append(textMessage("user", "hi"));
    await store.appendThinkingLevelChange("off");
    expect(store.thinkingLevel()).toBe("off");

    const reopened = await SessionStore.open(file);
    expect(reopened.thinkingLevel()).toBe("off");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).type)).toEqual([
      "session",
      "thinking_level_change",
      "message",
      "thinking_level_change",
    ]);

    store.branch(prompt.id);
    expect(store.thinkingLevel()).toBe("on");
  });
});
