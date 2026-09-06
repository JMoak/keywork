import { strict as assert } from "node:assert";
import { columnOf } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";

export const pointerOff: Scenario = {
  name: "pointer-off",
  description: "pointer: off leaves every mouse gesture inert",
  app: { pointer: "off" },
  run: async (stage) => {
    await stage.settle();
    await stage.press("ctrl+k", "s", "escape");
    const split = await stage.until("session-2");
    const firstColumn = columnOf(split, "session-1");
    await stage.click(firstColumn + 2, 10);
    await stage.type("hi");
    const typed = await stage.until("› hi");
    assert.ok(
      columnOf(typed, "› hi") > firstColumn + 10,
      "the click never lands, so typing stays in the freshly split pane",
    );
    await stage.quit();
  },
};
