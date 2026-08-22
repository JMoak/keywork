import { strict as assert } from "node:assert";
import { textTurn } from "../../../packages/engine/src/index.ts";
import { occurrences, paneTitleCount } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";
import { listTool } from "./fixtures.ts";

const reply = "Noted. The plan is recorded.";
const toolProse = "Counting the files now.";
const toolVerdict = "There are 4 files here.";
const settledToolMark = "· done";
const replayToolLine = "░ list · done";

export const sessionLifecycle: Scenario = {
  name: "session-lifecycle",
  description:
    "converse → sessions overview → drill in → label → fork → live overview → switchboard enter → tool turn → quit → relaunch restores layout, sessions, and clean tool replay",
  tools: () => [listTool],
  turns: [
    textTurn(reply),
    [
      {
        type: "tool-call",
        call: { type: "tool-call", callId: "call-list", name: "list", arguments: {} },
      },
      { type: "text", text: toolProse },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ],
    textTurn(toolVerdict),
  ],
  run: async (stage) => {
    await stage.settle();
    await stage.type("plan the fix");
    await stage.press("enter");
    await stage.until(reply);
    await stage.until("─ session-1 · ░");
    await stage.capture("conversation");

    await stage.press("ctrl+k", "t", "escape");
    const overviewOne = await stage.until("▓ plan the fix · now");
    assert.ok(overviewOne.includes("session tree · 1 session"), "the overview counts its rows");
    await stage.capture("sessions-overview-one");

    await stage.press("l");
    await stage.until("● user: plan the fix");
    await stage.capture("entries-drilled");

    await stage.press("shift+l");
    await stage.type("keep");
    await stage.press("enter");
    await stage.until("[keep]");
    await stage.capture("tree-labeled");

    await stage.press("j", "f");
    await stage.until("session-2");
    await stage.settle();
    const forked = await stage.capture("forked-layout");
    assert.equal(paneTitleCount(forked), 2, "the fork opens a second session pane");

    await stage.press("ctrl+k", "t", "escape");
    const overview = await stage.until("session tree · 2 sessions");
    assert.equal(
      occurrences(overview, "▓ plan the fix · now"),
      2,
      "the fork lands in the overview unprompted, both sessions marked attached",
    );
    await stage.capture("sessions-overview-live");

    await stage.press("enter");
    await stage.settle();
    await stage.type("count the files");
    await stage.press("enter");
    await stage.until(settledToolMark);
    await stage.until(toolVerdict);
    await stage.settle();
    await stage.capture("tool-turn");

    await stage.relaunch();
    await stage.until(reply);
    await stage.until(replayToolLine);
    await stage.settle();
    const restored = await stage.capture("relaunched-restored");
    assert.equal(paneTitleCount(restored), 2, "both session panes come back");
    assert.ok(
      restored.includes("session tree · 2 sessions"),
      "the persisted tree pane revives into the sessions overview",
    );
    assert.ok(restored.includes("plan the fix"), "the revived session replays the prompt");
    assert.ok(restored.includes(toolVerdict), "the closing prose replays after the tool entry");
    const proseAt = restored.indexOf(toolProse);
    const toolAt = restored.indexOf(replayToolLine);
    assert.ok(
      proseAt >= 0 && proseAt < toolAt,
      "replay keeps the streamed prose before the settled tool line, as it rendered live",
    );
    assert.ok(
      !restored.includes(`${toolProse}${toolVerdict}`),
      "tool-entry replay never merges prose across turns",
    );
    await stage.quit();
  },
};
