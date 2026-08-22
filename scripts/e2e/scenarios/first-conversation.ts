import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { textTurn, toolScope, writeTool } from "../../../packages/engine/src/index.ts";
import type { Scenario, Stage } from "../scenario.ts";
import { notesAfter, notesBefore } from "./fixtures.ts";

const askRowMarker = "[y] allow  [a] always  [n] deny";

export const firstConversation: Scenario = {
  name: "first-conversation",
  description: "prompt → streamed reply → write ask with diff → approve → /undo → /redo",
  files: { "notes.txt": notesBefore },
  tools: (workspaceDir) => [writeTool(toolScope(workspaceDir))],
  turns: [
    [
      { type: "text", text: "Shouting the middle line of notes.txt now." },
      {
        type: "tool-call",
        call: {
          type: "tool-call",
          callId: "call-1",
          name: "write",
          arguments: { path: "notes.txt", content: notesAfter },
        },
      },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ],
    textTurn("All set, beta is BETA now."),
  ],
  run: async (stage) => {
    await stage.settle();
    await stage.capture("boot");

    await stage.type("please shout the middle line of notes.txt");
    await stage.press("enter");
    const ask = await stage.until(askRowMarker);
    assert.ok(ask.includes("Shouting the middle line"), "streamed reply precedes the ask");
    assert.ok(ask.includes("- beta"), "diff preview shows the removed line");
    assert.ok(ask.includes("+ BETA"), "diff preview shows the added line");
    await stage.capture("ask-with-diff");

    await stage.press("y");
    const settled = await stage.until("All set, beta is BETA now.");
    assert.ok(settled.includes("write notes.txt"), "the tool row names its verb and subject");
    assert.ok(settled.includes("· done"), "the tool row settles to its outcome word");
    assert.equal(workspaceRead(stage, "notes.txt"), notesAfter);
    await stage.until("─ session-1 · ░");
    await stage.capture("turn-complete");

    await stage.type("/undo");
    await stage.press("enter");
    await stage.until("files put back");
    assert.equal(workspaceRead(stage, "notes.txt"), notesBefore);
    await stage.capture("undo-notice");

    await stage.type("/redo");
    await stage.press("enter");
    await stage.until("files redone");
    assert.equal(workspaceRead(stage, "notes.txt"), notesAfter);
    await stage.capture("redo-notice");

    await stage.quit();
  },
};

function workspaceRead(stage: Stage, path: string): string {
  return readFileSync(join(stage.workspaceDir, path), "utf8");
}
