import { strict as assert } from "node:assert";
import { paneTitleCount } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";

export const chromaSweep: Scenario = {
  name: "chroma-sweep",
  description: "spawn-rank border hues sweeping the theme ramp, and the recompute on close",
  run: async (stage) => {
    await stage.settle();
    const boot = await stage.capture("boot");
    assert.equal(paneTitleCount(boot), 1, "boot holds one session pane beside the tree");

    await stage.press("ctrl+k", "s", "s", "s", "escape");
    await stage.settle();
    const swept = await stage.capture("four-pane-sweep");
    assert.equal(paneTitleCount(swept), 4, "three splits spread four panes along the ramp");

    await stage.type("/exit");
    await stage.press("enter");
    await stage.settle();
    const respread = await stage.capture("after-close");
    assert.equal(paneTitleCount(respread), 3, "a close respreads the survivors");

    await stage.quit();
  },
};
