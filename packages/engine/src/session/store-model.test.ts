import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import { SessionStore } from "./store.ts";

const tempDirs: string[] = [];

async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-store-model-"));
  tempDirs.push(dir);
  return join(dir, "session.jsonl");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionStore model selection (IR-12)", () => {
  it("has no selection until a model_change is recorded", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    expect(store.modelSelection()).toBeUndefined();
  });

  it("records provider-qualified changes and resolves the last one on the active path", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    await store.appendModelChange("ollama", "qwen3");
    await store.append(textMessage("user", "hi"));
    await store.appendModelChange("openai", "gpt-5");
    expect(store.modelSelection()).toMatchObject({ provider: "openai", modelId: "gpt-5" });

    const reopened = await SessionStore.open(file);
    expect(reopened.modelSelection()).toMatchObject({ provider: "openai", modelId: "gpt-5" });
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).type)).toEqual([
      "session",
      "model_change",
      "message",
      "model_change",
    ]);
  });

  it("follows the branch: a selection on another branch does not leak into the active path", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    await store.appendModelChange("ollama", "qwen3");
    const prompt = await store.append(textMessage("user", "first"));
    await store.appendModelChange("openai", "gpt-5");
    store.branch(prompt.id);
    expect(store.modelSelection()).toMatchObject({ provider: "ollama", modelId: "qwen3" });
  });
});
