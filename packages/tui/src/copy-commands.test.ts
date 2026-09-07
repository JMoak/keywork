import { describe, expect, it } from "vitest";
import { CommandRegistry } from "./commands.ts";
import { ConversationModel } from "./conversation-model.ts";
import {
  type CopyDeps,
  copyCommands,
  lastCodeBlock,
  lastDiff,
  lastReply,
} from "./copy-commands.ts";
import type { ToolRun } from "./transcript-feed.ts";

function modelWith(...entries: ConversationModel["entries"][number][]): ConversationModel {
  const model = new ConversationModel(undefined, () => {});
  model.feed.entries.length = 0;
  model.feed.entries.push(...entries);
  return model;
}

function toolRun(name: string, args: Record<string, unknown>): ToolRun {
  return {
    name,
    subject: "",
    args: JSON.stringify(args),
    replay: false,
    provenance: "agent",
    startedAtMs: 0,
    folded: true,
  };
}

function harness(model: ConversationModel | undefined, clipboard = true) {
  const bytes: string[] = [];
  const notices: string[] = [];
  const deps: CopyDeps = {
    conversation: () => model,
    write: (chunk) => bytes.push(chunk),
    notice: (text) => notices.push(text),
    clipboard,
  };
  const registry = new CommandRegistry();
  for (const command of copyCommands(deps)) registry.register(command);
  return { bytes, notices, registry };
}

describe("picking what to copy", () => {
  it("takes the newest reply", () => {
    const model = modelWith(
      { kind: "assistant", text: "first" },
      { kind: "user", text: "more" },
      { kind: "assistant", text: "second" },
    );
    expect(lastReply(model)).toBe("second");
  });

  it("takes the last fenced block of the newest reply that has one, fence lines stripped", () => {
    const model = modelWith(
      { kind: "assistant", text: "```ts\nconst a = 1;\n```" },
      { kind: "assistant", text: "prose\n\n```py\nx\n```\n\n```sh\nbun run test\n```\n\ndone" },
      { kind: "assistant", text: "no code here" },
    );
    expect(lastCodeBlock(model)).toBe("bun run test");
  });

  it("keeps an unclosed fence's body", () => {
    const model = modelWith({ kind: "assistant", text: "```\nstill\nopen" });
    expect(lastCodeBlock(model)).toBe("still\nopen");
  });

  it("prefers the pending ask's diff", () => {
    const model = new ConversationModel(undefined, () => {}, undefined, undefined, {
      readFile: () => "a\nb\nc\n",
    });
    void model.confirmMutation({
      type: "tool-call",
      callId: "c1",
      name: "edit",
      arguments: { path: "x.txt", oldText: "b", newText: "B" },
    });
    expect(lastDiff(model)).toBe("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
  });

  it("rebuilds the last edit's hunk from its recorded arguments after the ask has passed", () => {
    const model = modelWith(
      {
        kind: "tool",
        text: "edit x.txt",
        failed: false,
        run: toolRun("edit", { path: "x.txt", oldText: "old line", newText: "new line" }),
      },
      { kind: "tool", text: "bash ls", failed: false, run: toolRun("bash", { command: "ls" }) },
    );
    expect(lastDiff(model)).toBe("@@ -1,1 +1,1 @@\n-old line\n+new line");
  });

  it("renders a write as one add hunk", () => {
    const model = modelWith({
      kind: "tool",
      text: "write x.txt",
      failed: false,
      run: toolRun("write", { path: "x.txt", content: "one\ntwo" }),
    });
    expect(lastDiff(model)).toBe("@@ -1,0 +1,2 @@\n+one\n+two");
  });

  it("finds nothing in an empty session", () => {
    const model = modelWith();
    expect(lastReply(model)).toBeUndefined();
    expect(lastCodeBlock(model)).toBeUndefined();
    expect(lastDiff(model)).toBeUndefined();
  });
});

describe("copy commands", () => {
  it("write OSC 52 with the base64 payload and say what was copied", () => {
    const { bytes, notices, registry } = harness(
      modelWith({ kind: "assistant", text: "hi\n```\ncode\n```" }),
    );
    expect(registry.run("copy-message")).toBe(true);
    expect(registry.run("copy-code")).toBe(true);
    expect(bytes).toEqual([
      `\x1b]52;c;${Buffer.from("hi\n```\ncode\n```").toString("base64")}\x07`,
      "\x1b]52;c;Y29kZQ==\x07",
    ]);
    expect(notices).toEqual([
      "copied the last reply · 15 chars",
      "copied the last code block · 4 chars",
    ]);
  });

  it("answer aliases and the bare /copy", () => {
    const { bytes, registry } = harness(modelWith({ kind: "assistant", text: "x" }));
    expect(registry.run("copy")).toBe(true);
    expect(registry.run("copy-reply")).toBe(true);
    expect(registry.run("copy-block")).toBe(true);
    expect(registry.run("copy-hunk")).toBe(true);
    expect(bytes).toHaveLength(2);
  });

  it("explain an empty copy without touching the terminal", () => {
    const { bytes, notices, registry } = harness(modelWith());
    registry.run("copy-message");
    registry.run("copy-code");
    registry.run("copy-diff");
    expect(bytes).toEqual([]);
    expect(notices).toEqual([
      "nothing to copy · no reply yet",
      "nothing to copy · no code block yet",
      "nothing to copy · no diff yet",
    ]);
  });

  it("ask for a focused session when none is", () => {
    const { bytes, notices, registry } = harness(undefined);
    registry.run("copy-message");
    expect(bytes).toEqual([]);
    expect(notices).toEqual(["nothing to copy · focus a session first"]);
  });

  it("stay quiet on a terminal that takes no clipboard writes", () => {
    const { bytes, notices, registry } = harness(
      modelWith({ kind: "assistant", text: "x" }),
      false,
    );
    registry.run("copy-message");
    expect(bytes).toEqual([]);
    expect(notices).toEqual(["this terminal takes no clipboard writes"]);
  });
});
