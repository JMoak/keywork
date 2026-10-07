import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Message, textMessage } from "../messages.ts";
import { SessionStore } from "./store.ts";

const tempDirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-store-context-edit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const callTurn: Message = {
  role: "assistant",
  parts: [
    { type: "text", text: "reading it" },
    { type: "tool-call", callId: "call-1", name: "read", arguments: { path: "secret.txt" } },
  ],
};

const callResult: Message = {
  role: "tool",
  parts: [{ type: "tool-result", callId: "call-1", output: "hunter2", isError: false }],
};

function texts(messages: readonly Message[]): string[] {
  return messages.map((message) =>
    message.parts
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "tool-result") return `result:${part.output}`;
        if (part.type === "tool-call") return `call:${part.callId}`;
        return part.type;
      })
      .join("+"),
  );
}

describe("SessionStore context edits (117, Pi ContextEditEntry)", () => {
  it("omits the target from model context with a null replacement and keeps raw history", async () => {
    const dir = await scratchDir();
    const store = await SessionStore.create(join(dir, "s.jsonl"), ".");
    const first = await store.append(textMessage("user", "my key is sk-123"));
    await store.append(textMessage("assistant", "noted"));

    await store.appendContextEdit(first.id, null);

    expect(texts(store.messages())).toEqual(["noted"]);
    expect(store.entry(first.id)).toMatchObject({
      message: textMessage("user", "my key is sk-123"),
    });
    const reopened = await SessionStore.open(join(dir, "s.jsonl"));
    expect(texts(reopened.messages())).toEqual(["noted"]);
  });

  it("substitutes the target's content with a replacement, keeping its role", async () => {
    const store = await SessionStore.create(join(await scratchDir(), "s.jsonl"), ".");
    const first = await store.append(textMessage("user", "my key is sk-123"));

    await store.appendContextEdit(first.id, "my key is [redacted]");

    expect(store.messages()).toEqual([textMessage("user", "my key is [redacted]")]);
  });

  it("replaces a tool result's output in place so the call stays answered", async () => {
    const store = await SessionStore.create(join(await scratchDir(), "s.jsonl"), ".");
    await store.append(textMessage("user", "read it"));
    await store.append(callTurn);
    const result = await store.append(callResult);

    await store.appendContextEdit(result.id, "[redacted]");

    expect(texts(store.messages())).toEqual([
      "read it",
      "reading it+call:call-1",
      "result:[redacted]",
    ]);
  });

  it("takes the counterpart of an omitted tool call out of context too", async () => {
    const store = await SessionStore.create(join(await scratchDir(), "s.jsonl"), ".");
    await store.append(textMessage("user", "read it"));
    await store.append(callTurn);
    const result = await store.append(callResult);

    await store.appendContextEdit(result.id, null);

    expect(texts(store.messages())).toEqual(["read it", "reading it"]);
  });

  it("lets a later edit of the same target win", async () => {
    const store = await SessionStore.create(join(await scratchDir(), "s.jsonl"), ".");
    const first = await store.append(textMessage("user", "original"));

    await store.appendContextEdit(first.id, null);
    await store.appendContextEdit(first.id, "second thoughts");

    expect(store.messages()).toEqual([textMessage("user", "second thoughts")]);
  });

  it("applies only on paths that include the edit", async () => {
    const store = await SessionStore.create(join(await scratchDir(), "s.jsonl"), ".");
    const first = await store.append(textMessage("user", "original"));
    const fork = await store.append(textMessage("assistant", "reply"));
    await store.appendContextEdit(first.id, null);
    expect(texts(store.messages())).toEqual(["reply"]);

    store.branch(fork.id);
    await store.append(textMessage("user", "sibling"));

    expect(texts(store.messages())).toEqual(["original", "reply", "sibling"]);
  });

  it("refuses targets that add no model context", async () => {
    const store = await SessionStore.create(join(await scratchDir(), "s.jsonl"), ".");
    const info = await store.setName("named");

    await expect(store.appendContextEdit(info.id, null)).rejects.toThrow("adds no model context");
    await expect(store.appendContextEdit("missing", null)).rejects.toThrow("no session entry");
  });

  it("shows the edit in the tree and carries it through a clone", async () => {
    const dir = await scratchDir();
    const store = await SessionStore.create(join(dir, "s.jsonl"), ".");
    const first = await store.append(textMessage("user", "original"));
    await store.append(textMessage("assistant", "reply"));
    const edit = await store.appendContextEdit(first.id, null);

    const tree = store.tree();
    const editNode = tree[0]?.children[0]?.children[0];
    expect(editNode?.entry).toEqual(edit);
    expect(editNode?.onActivePath).toBe(true);

    const clone = await store.clone(join(dir, "clone.jsonl"));
    expect(texts(clone.messages())).toEqual(["reply"]);
    const cloned = (await readFile(join(dir, "clone.jsonl"), "utf8")).trim().split("\n");
    expect(cloned.map((line) => JSON.parse(line).type)).toContain("context_edit");
  });

  it("applies an edit to entries kept through a compaction", async () => {
    const store = await SessionStore.create(join(await scratchDir(), "s.jsonl"), ".");
    await store.append(textMessage("user", "old"));
    const kept = await store.append(textMessage("user", "kept"));
    await store.appendCompaction({
      summary: "summary",
      firstKeptEntryId: kept.id,
      tokensBefore: 10,
    });

    await store.appendContextEdit(kept.id, "kept, edited");

    expect(texts(store.messages())).toEqual(["summary", "kept, edited"]);
  });
});
