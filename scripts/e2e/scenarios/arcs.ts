import { strict as assert } from "node:assert";
import { textTurn } from "../../../packages/engine/src/index.ts";
import { occurrences } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";

export const arcsOnScreen: Scenario = {
  name: "arcs",
  description:
    "/arc new binds and tags the pane → split inherits → arcs node groups sessions → split-arc mints a fresh arc → picker → close through the airlock",
  size: { width: 160, height: 40 },
  files: { ".keywork/workspace.json": `${JSON.stringify({ name: "arcs-e2e" })}\n` },
  turns: [textTurn("noted.")],
  run: async (stage) => {
    await stage.settle();
    await stage.type("/arc new dock-v2");
    await stage.press("enter");
    const bound = await stage.until("arc → dock-v2 · new");
    assert.ok(bound.includes("session-1 #dock-v2"), "the title carries the arc tag at broadsheet");
    await stage.settle();
    await stage.capture("arc-bound");

    await stage.press("ctrl+k", "s", "escape");
    await stage.until("session tree · 2 sessions");
    await stage.settle();
    const inherited = await stage.capture("split-inherits-arc");
    assert.ok(
      occurrences(inherited, "#dock-v2") >= 3,
      "both overview rows carry the tag and the status line wears the focused arc chip",
    );
    assert.ok(inherited.includes("· #dock-v2 ·"), "the status line wears the focused arc chip");

    await stage.type("/arcs");
    await stage.press("enter");
    const node = await stage.until("dock-v2 · 2 sessions");
    assert.ok(node.includes(" arcs · 1 arc "), "the arcs node titles itself with the active count");
    await stage.settle();
    await stage.capture("arcs-node");

    await stage.press("ctrl+k", "l", "escape");
    await stage.press("ctrl+k", "shift+s", "escape");
    await stage.until("arc → arc-2 · new");
    const minted = await stage.until("arc-2 · 1 session");
    assert.ok(minted.includes("dock-v2 · 2 sessions"), "split-arc leaves the source arc alone");
    await stage.settle();
    await stage.capture("split-new-arc");

    await stage.type("/arc");
    await stage.press("enter");
    const picker = await stage.until("no arc · release this session");
    assert.ok(picker.includes("arc-2 · 1 session · current"), "the picker marks the bound arc");
    assert.ok(picker.includes("dock-v2 · 2 sessions"), "the picker counts bound sessions");
    await stage.capture("arc-picker");
    await stage.press("escape");

    await stage.type("/arc none");
    await stage.press("enter");
    await stage.until("arc released");
    await stage.until("no arc · 1 session");
    await stage.press("escape");
    await stage.settle();
    const released = await stage.capture("arc-released");
    assert.ok(!released.includes("· #arc-2 ·"), "releasing drops the status chip");

    await stage.type("/arc close dock-v2");
    await stage.press("enter");
    await stage.until("arc dock-v2 closed · delivered 0 notes · 2 sessions released");
    await stage.until("dock-v2 · archived");
    await stage.settle();
    await stage.capture("arc-closed");

    await stage.quit();
  },
};
