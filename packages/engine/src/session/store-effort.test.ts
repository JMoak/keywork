import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import { SessionStore } from "./store.ts";

const tempDirs: string[] = [];

async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-store-effort-"));
  tempDirs.push(dir);
  return join(dir, "session.jsonl");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionStore effort (SW4)", () => {
  it("has no effort until a change is recorded", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    expect(store.effort()).toBeUndefined();
  });

  it("round-trips effort_change entries through the JSONL file and resolves the last one on the active path", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    await store.appendEffortChange("high");
    const prompt = await store.append(textMessage("user", "hi"));
    await store.appendEffortChange("low");
    expect(store.effort()).toBe("low");

    const reopened = await SessionStore.open(file);
    expect(reopened.effort()).toBe("low");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).type)).toEqual([
      "session",
      "effort_change",
      "message",
      "effort_change",
    ]);

    store.branch(prompt.id);
    expect(store.effort()).toBe("high");
  });
});
