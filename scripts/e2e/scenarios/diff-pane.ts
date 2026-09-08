import { strict as assert } from "node:assert";
import { textTurn, toolScope, writeTool } from "../../../packages/engine/src/index.ts";
import type { Scenario } from "../scenario.ts";
import { notesAfter, notesBefore } from "./fixtures.ts";

const askRowMarker = "[y] allow  [a] always  [n] deny";
const calmHeader = /│ session-1 +│/;
const emptyRow = "no changes since session start";
const changedRow = "notes.txt  +1 -1 · turn 1";
const hunkHeader = "@@ -1,3 +1,3 @@";
const frozenClock = (): number => Date.parse("2026-09-07T12:00:00.000Z");

export const diffPane: Scenario = {
  name: "diff-pane",
  description:
    "C14: /diff docks right over the session-start checkpoint → a mock write lands in the file list and the unified diff → /undo empties it → /redo brings it back → enter opens the file at its first hunk",
  size: { width: 160, height: 40 },
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
  app: { clock: frozenClock },
  goldens: ["after-write", "after-undo"],
  run: async (stage) => {
    await stage.settle();
    await stage.type("/diff");
    await stage.press("enter");
    const opened = await stage.until(emptyRow);
    assert.ok(opened.includes("│ diff "), "the pane titles itself diff before anything changes");

    await stage.press("ctrl+p");
    await stage.type("session-1");
    await stage.press("enter");
    await stage.type("please shout the middle line of notes.txt");
    await stage.press("enter");
    await stage.until(askRowMarker);
    await stage.press("y");
    await stage.until("All set, beta is BETA now.");
    const written = await stage.until(changedRow);
    assert.ok(written.includes("diff · 1 file · +1 -1"), "the title carries the totals");
    await stage.until(calmHeader);
    const settled = await stage.until(hunkHeader);
    assert.ok(settled.includes("- beta"), "the removed line shows in the body");
    assert.ok(settled.includes("+ BETA"), "the added line shows in the body");
    await stage.capture("after-write");

    await stage.type("/undo");
    await stage.press("enter");
    await stage.until("files put back");
    await stage.until(emptyRow);
    await stage.capture("after-undo");

    await stage.type("/redo");
    await stage.press("enter");
    await stage.until("files redone");
    await stage.until(changedRow);

    await stage.press("ctrl+k", "g", "escape");
    await stage.press("enter");
    const viewer = await stage.until("│ notes.txt · 4 lines");
    assert.ok(viewer.includes("2 BETA"), "enter opens the changed file in a viewer pane");
    await stage.quit();
  },
};
