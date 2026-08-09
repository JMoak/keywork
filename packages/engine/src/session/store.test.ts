import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import { SessionStore } from "./store.ts";

const tempDirs: string[] = [];

async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-session-"));
  tempDirs.push(dir);
  return join(dir, "session.jsonl");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionStore", () => {
  it("round-trips a conversation through disk", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, "C:\\repo");
    await store.append(textMessage("user", "hi"));
    await store.append(textMessage("assistant", "hello"));

    const reopened = await SessionStore.open(file);

    expect(reopened.header.cwd).toBe("C:\\repo");
    expect(reopened.messages()).toEqual([
      textMessage("user", "hi"),
      textMessage("assistant", "hello"),
    ]);
  });

  it("links entries into a parent chain", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    const first = await store.append(textMessage("user", "one"));
    const second = await store.append(textMessage("assistant", "two"));

    expect(first.parentId).toBeNull();
    expect(second.parentId).toBe(first.id);
  });

  it("survives a torn final line", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    await store.append(textMessage("user", "kept"));
    await appendFile(file, '{"type":"message","id":"torn', "utf8");

    const reopened = await SessionStore.open(file);

    expect(reopened.messages()).toEqual([textMessage("user", "kept")]);
  });

  it("rejects files without a session header", async () => {
    const file = await sessionFile();
    await appendFile(file, '{"type":"message","id":"x","parentId":null}\n', "utf8");

    await expect(SessionStore.open(file)).rejects.toThrow(/not a keywork session/);
  });
});
