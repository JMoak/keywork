import { strict as assert } from "node:assert";
import { columnOf, paneTitleCount, rowOf } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";
import { notesBefore } from "./fixtures.ts";

export const tilingTour: Scenario = {
  name: "tiling-tour",
  description: "splits, nav, zoom, dual docks, dock resize, cycling a pane through all homes",
  files: {
    "notes.txt": notesBefore,
    "README.md": "# demo workspace\n",
    "src/app.ts": "export const answer = 42;\n",
  },
  run: async (stage) => {
    await stage.settle();
    const boot = await stage.capture("boot");
    assert.ok(boot.includes("session-1"), "boots into the first session pane");
    assert.ok(boot.includes("keywork e2e"), "status bar carries the harness label");

    await stage.press("ctrl+k", "s", "s", "escape");
    await stage.settle();
    const tiled = await stage.capture("three-panes");
    assert.equal(paneTitleCount(tiled), 3, "two splits leave three session panes");
    assert.ok(tiled.includes("4 panes"), "status bar counts the sessions node too");

    await stage.press("ctrl+k", "h", "escape");
    await stage.settle();
    await stage.capture("nav-left");

    await stage.press("ctrl+k", "z", "escape");
    await stage.settle();
    const zoomed = await stage.capture("zoomed");
    assert.equal(paneTitleCount(zoomed), 1, "zoom shows a single session pane");

    await stage.press("ctrl+k", "z", "escape");
    await stage.settle();
    const unzoomed = await stage.capture("unzoomed");
    assert.equal(paneTitleCount(unzoomed), 3, "zoom toggles back to the full tiling");

    const borderBefore = columnOf(unzoomed, "session-3");
    await stage.type("/grow");
    await stage.press("enter");
    await stage.type("/grow");
    await stage.press("enter");
    await stage.settle();
    const grown = await stage.capture("pane-grown");
    assert.ok(
      columnOf(grown, "session-3") > borderBefore,
      "growing the focused pane visibly moves the shared border",
    );

    await stage.type("/browse");
    await stage.press("enter");
    const docked = await stage.until(" workspace · 3 entries ");
    assert.ok(docked.includes("src"), "browser lists the seeded directory");
    assert.ok(docked.includes("notes.txt"), "browser lists the seeded file");
    assert.equal(paneTitleCount(docked), 3, "docking the browser keeps all session panes");
    await stage.capture("browser-docked");

    await stage.press("ctrl+k", "t", "escape");
    const withTree = await stage.until("session tree");
    assert.ok(withTree.includes(" workspace "), "browser stays docked beside the tree");
    assert.ok(
      rowOf(withTree, " session tree ") < rowOf(withTree, " workspace "),
      "the browser arrived below the tree that was docked at boot",
    );
    await stage.capture("session-tree");

    await stage.press("ctrl+k", "j", "p", "escape");
    const pinned = await stage.until(" ▪ workspace ");
    assert.ok(
      rowOf(pinned, " ▪ workspace ") < rowOf(pinned, " session tree "),
      "pinning lifts the browser to the head of its dock, mark first in the title",
    );
    await stage.capture("browser-pinned");
    await stage.press("ctrl+k", "p", "escape");
    await stage.settle();
    const unpinned = await stage.capture("browser-unpinned");
    assert.ok(!unpinned.includes(" ▪ "), "the same chord unpins and clears the mark");
    assert.ok(
      rowOf(unpinned, " workspace ") < rowOf(unpinned, " session tree "),
      "unpinning leaves the pane where it sits",
    );

    const mainColumnBefore = columnOf(withTree, "session-1");
    await stage.press("ctrl+k", ".", ".", "escape");
    await stage.settle();
    const widened = await stage.capture("dock-wider");
    assert.ok(
      columnOf(widened, "session-1") > mainColumnBefore,
      "widening the dock pushes the main area right",
    );

    await stage.press("ctrl+k", "l", "escape");
    await stage.type("/dock-right");
    await stage.press("enter");
    await stage.settle();
    const dualDocks = await stage.capture("dual-docks");
    assert.ok(dualDocks.includes(" workspace "), "the browser holds the left dock");
    assert.ok(
      columnOf(dualDocks, "session-1") > columnOf(dualDocks, "session-2"),
      "the docked-right session sits past the main area",
    );

    await stage.press("ctrl+k", "c", "escape");
    await stage.settle();
    const cycledToMain = await stage.capture("cycle-to-main");
    assert.equal(
      columnOf(cycledToMain, "session-1"),
      columnOf(cycledToMain, "session-2"),
      "one cycle brings the pane from the right dock into the main column",
    );

    await stage.press("ctrl+k", "c", "escape");
    await stage.settle();
    const cycledToLeft = await stage.capture("cycle-to-left");
    assert.ok(
      columnOf(cycledToLeft, "session-1") < columnOf(cycledToLeft, "session-2"),
      "the next cycle lands the pane in the left dock",
    );

    await stage.press("ctrl+k", "c", "escape");
    await stage.settle();
    const cycledHome = await stage.capture("cycle-home");
    assert.equal(
      columnOf(cycledHome, "session-1"),
      columnOf(dualDocks, "session-1"),
      "three cycles return the pane to its right-dock home",
    );

    await stage.quit();
  },
};
