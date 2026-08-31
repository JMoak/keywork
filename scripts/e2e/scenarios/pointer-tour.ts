import { strict as assert } from "node:assert";
import { textTurn } from "../../../packages/engine/src/index.ts";
import { columnOf, frameLine, rowOf } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";
import { notesBefore } from "./fixtures.ts";

const reply = Array.from({ length: 40 }, (_, at) => `line ${at + 1}`).join("\n");

export const pointerTour: Scenario = {
  name: "pointer-tour",
  description:
    "mouse through the real renderer: click focus survives rebuilds, wheel scrollback, dock drag",
  files: { "notes.txt": notesBefore, "src/app.ts": "export const answer = 42;\n" },
  turns: [textTurn(reply)],
  run: async (stage) => {
    await stage.settle();
    await stage.type("/browse");
    await stage.press("enter");
    const docked = await stage.until(" workspace · 2 entries ");
    await stage.capture("browser-docked");

    const mainColumn = columnOf(docked, "session-1");
    await stage.click(mainColumn + 2, 12);
    await stage.type("hi");
    const typed = await stage.until("› hi");
    assert.ok(typed.includes("› hi"), "clicking the main pane focuses the conversation");

    await stage.click(4, rowOf(typed, " workspace ") + 2);
    await stage.press("enter");
    const expanded = await stage.until("app.ts");
    assert.ok(
      expanded.includes("app.ts"),
      "a second click, after frame rebuilds, still reaches the browser",
    );
    await stage.capture("click-focus");

    await stage.click(mainColumn + 2, 12);
    await stage.press("enter");
    await stage.until("line 40");
    await stage.scroll(mainColumn + 10, 12, "up", 3);
    const scrolled = await stage.until("esc returns to live");
    assert.ok(scrolled.includes("line 1"), "wheel over the pane scrolls the transcript back");
    await stage.capture("wheel-scrollback");
    await stage.press("escape");

    const before = await stage.settle().then(() => stage.capture("before-dock-drag"));
    const junction = frameLine(before, 1).indexOf("│", 1);
    assert.ok(junction > 0, "a seam separates the dock from the main area");
    await stage.drag({ x: junction, y: 15 }, { x: junction + 6, y: 15 });
    await stage.settle();
    const dragged = await stage.capture("dock-dragged");
    assert.ok(
      columnOf(dragged, "session-1") > columnOf(before, "session-1"),
      "dragging the dock boundary visibly widens the dock",
    );

    await stage.quit();
  },
};
