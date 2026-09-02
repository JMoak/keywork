import { strict as assert } from "node:assert";
import { textTurn, toolScope, writeTool } from "../../../packages/engine/src/index.ts";
import { paneTitleCount } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";
import { notesAfter, notesBefore } from "./fixtures.ts";

const askRowMarker = "[y] allow  [a] always  [n] deny";
const foldedRow = "░ (untitled session) · folded · now";
const waitingRow = "█ (untitled session) · needs you · now";

export const arcFold: Scenario = {
  name: "arc-fold",
  description:
    "arc pane folds a member (tile gone, row ░) → a folds all → a unfolds all → a folded member asks (needs you, pane stamp) → enter unfolds and focuses → relaunch restores the fold",
  size: { width: 160, height: 40 },
  files: {
    ".keywork/workspace.json": `${JSON.stringify({ name: "arc-fold-e2e" })}\n`,
    "notes.txt": notesBefore,
  },
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
    await stage.type("/arc-new fold-v1");
    await stage.press("enter");
    await stage.until("│ #fold-v1 · 1 session ");
    await stage.press("ctrl+k", "s", "escape");
    await stage.until("│ #fold-v1 · 2 sessions ");
    await stage.type("please shout the middle line of notes.txt");
    await stage.press("enter");
    await stage.until(askRowMarker);
    await stage.settle();

    await stage.press("ctrl+p");
    await stage.type("#fold-v1");
    const quickOpen = await stage.until("#fold-v1  ");
    assert.ok(
      quickOpen.includes("2 sessions"),
      "quick-open lists the arc with its member count as the hint",
    );
    await stage.capture("quick-open-arc");
    await stage.press("enter");
    await stage.press("space");
    const oneFolded = await stage.until("│ #fold-v1 · 2 sessions · 1 folded ");
    assert.equal(paneTitleCount(oneFolded), 1, "folding a member takes its tile off the screen");
    assert.ok(oneFolded.includes(foldedRow), "the folded member's row wears the fold mark");
    await stage.capture("member-folded");

    await stage.press("a");
    const allFolded = await stage.until("│ █ #fold-v1 · 2 sessions · 2 folded ");
    assert.equal(paneTitleCount(allFolded), 0, "a folds every shown member");
    assert.ok(allFolded.includes(waitingRow), "a folded member that asks reads needs you");
    await stage.capture("all-folded-one-waiting");

    await stage.press("a");
    const allShown = await stage.until("│ #fold-v1 · 2 sessions ");
    assert.equal(paneTitleCount(allShown), 2, "a unfolds them all when none is shown");
    assert.ok(allShown.includes(askRowMarker), "the unfolded member still holds its ask");
    await stage.capture("all-unfolded");

    await stage.press("space", "j", "space");
    await stage.until("│ █ #fold-v1 · 2 sessions · 2 folded ");
    await stage.press("enter");
    const unfolded = await stage.until("│ #fold-v1 · 2 sessions · 1 folded ");
    assert.equal(paneTitleCount(unfolded), 1, "enter unfolds only the member it names");
    assert.ok(unfolded.includes(askRowMarker), "enter lands on the member that needs you");
    await stage.capture("enter-unfolds-and-focuses");
    await stage.press("y");
    await stage.until("All set, beta is BETA now.");
    await stage.settle();

    await stage.relaunch();
    const restored = await stage.until("│ #fold-v1 · 2 sessions · 1 folded ");
    assert.equal(paneTitleCount(restored), 1, "the fold survives a relaunch: one tile, one held");
    assert.ok(restored.includes(foldedRow), "the held member is still reported as folded");
    await stage.capture("relaunched-fold-restored");
    await stage.quit();
  },
};
