import { strict as assert } from "node:assert";
import { textTurn } from "../../../packages/engine/src/index.ts";
import { columnOf, occurrences } from "../frame-queries.ts";
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
    assert.ok(bound.includes("#dock-v2"), "the arc tag shows as soon as the arc binds");
    const introduced = await stage.until("│ #dock-v2 · 1 session ");
    assert.ok(
      columnOf(introduced, "│ #dock-v2 · 1 session ") < columnOf(introduced, "│ session-1"),
      "the first arc introduces its arc pane into the dock that already holds the tree",
    );
    assert.ok(introduced.includes(" · idle · "), "the member row carries its state word");
    await stage.settle();
    await stage.capture("arc-bound");

    await stage.press("ctrl+k", "s", "escape");
    await stage.until("session tree · 2 sessions");
    await stage.until("│ #dock-v2 · 2 sessions ");
    await stage.settle();
    const inherited = await stage.capture("split-inherits-arc");
    assert.ok(
      occurrences(inherited, "#dock-v2") >= 3,
      "both overview rows carry the tag and the status line wears the focused arc chip",
    );
    assert.ok(inherited.includes("· #dock-v2 ·"), "the status line wears the focused arc chip");

    await stage.type("/arcs");
    await stage.press("enter");
    const node = await stage.until(" arcs · 1 arc ");
    assert.ok(node.includes("▓ dock-v2 · 2 sessions"), "the arcs node groups both sessions");
    await stage.settle();
    await stage.capture("arcs-node");

    await stage.press("ctrl+k", "l", "escape");
    await stage.press("ctrl+k", "shift+s", "escape");
    await stage.until("arc → arc-2 · new");
    const minted = await stage.until("arc-2 · 1 session");
    assert.ok(minted.includes("dock-v2 · 2 sessions"), "split-arc leaves the source arc alone");
    await stage.settle();
    const afterSecondArc = await stage.capture("split-new-arc");
    assert.equal(
      occurrences(afterSecondArc, "│ #arc-2"),
      0,
      "only the first arc of a workspace introduces its pane",
    );

    await stage.type("/arc open arc-2");
    await stage.press("enter");
    const opened = await stage.until("│ #arc-2 · 1 session ");
    assert.ok(
      columnOf(opened, "│ #arc-2 · 1 session ") < columnOf(opened, "│ session-1"),
      "/arc open lands the pane in the dock that holds the arcs node",
    );
    await stage.settle();
    await stage.capture("arc-pane-opened");
    await stage.press("ctrl+p");
    await stage.type("session-3");
    await stage.press("enter");

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
