import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, messageText, SessionStore, textTurn, toolCallTurn } from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { runHeadless } from "./run.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runHeadless", () => {
  it("streams JSONL events for a tool-using run and persists the session", async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "bash",
        arguments: { command: "echo from-e2e" },
      }),
      textTurn("done"),
    ]);
    const lines: string[] = [];

    const final = await runHeadless({
      prompt: "run echo",
      cwd,
      json: true,
      sessionDir,
      provider,
      print: (line) => lines.push(line),
    });

    expect(messageText(final)).toBe("done");
    const events = lines.map((line) => JSON.parse(line));
    const types = events.map((event) => event.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.finished");
    expect(types.at(-1)).toBe("turn.completed");
    const toolFinished = events.find((event) => event.type === "tool.finished");
    expect(toolFinished.output).toContain("from-e2e");

    const files = await readdir(sessionDir);
    expect(files).toHaveLength(1);
    const store = await SessionStore.open(join(sessionDir, files[0] as string));
    expect(store.messages().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("prints plain text when json is off", async () => {
    const cwd = await tempDir();
    const provider = new MockProvider([textTurn("plain answer")]);
    const lines: string[] = [];

    await runHeadless({ prompt: "hi", cwd, json: false, provider, print: (l) => lines.push(l) });

    expect(lines).toEqual(["plain answer"]);
  });
});
