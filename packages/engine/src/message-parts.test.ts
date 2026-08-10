import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message, Usage } from "./messages.ts";
import { MockProvider, textTurn } from "./mock-provider.ts";
import { SessionStore } from "./session/store.ts";

const richMessage: Message = {
  role: "user",
  parts: [
    { type: "text", text: "describe this screenshot" },
    { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
  ],
};

const thoughtfulReply: Message = {
  role: "assistant",
  parts: [
    { type: "thinking", thinking: "the image is tiny", signature: "sig==" },
    { type: "redacted-thinking", data: "opaque==" },
    { type: "text", text: "it says hello" },
  ],
};

const cachedUsage: Usage = {
  inputTokens: 2048,
  outputTokens: 64,
  cacheCreationInputTokens: 1024,
  cacheReadInputTokens: 512,
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-parts-"));
  tempDirs.push(dir);
  return join(dir, "session.jsonl");
}

describe("rich message parts", () => {
  it("stream through the mock provider untouched", async () => {
    const provider = new MockProvider([textTurn("it says hello")]);
    const deltas = [];
    for await (const delta of provider.stream({
      systemPrompt: "",
      messages: [richMessage],
      tools: [],
    })) {
      deltas.push(delta);
    }
    expect(deltas[0]).toEqual({ type: "text", text: "it says hello" });
  });

  it("persist through the session store losslessly, cache usage included", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    await store.append(richMessage);
    await store.append(thoughtfulReply, cachedUsage);

    const reopened = await SessionStore.open(file);

    expect(reopened.messages()).toEqual([richMessage, thoughtfulReply]);
    expect(reopened.entries().at(-1)).toMatchObject({ usage: cachedUsage });
  });
});
