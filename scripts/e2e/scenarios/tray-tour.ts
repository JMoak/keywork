import { strict as assert } from "node:assert";
import { frameLine, rowOf } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";

export const trayTour: Scenario = {
  name: "tray-tour",
  description: "one tray grammar: chat slash tray, entity tray, hover, click, outside dismiss",
  goldens: ["chat-tray", "entity-tray"],
  run: async (stage) => {
    await stage.settle();

    await stage.type("/ke");
    const chat = await stage.until("show the hotkeys overlay");
    await stage.capture("chat-tray");
    const keysRow = rowOf(chat, "show the hotkeys overlay");
    const keysColumn = frameLine(chat, keysRow).indexOf("keys");
    assert.ok(keysColumn > 0, "the chat tray lists the keys command");
    await stage.click(keysColumn + 1, keysRow);
    await stage.until(" keywork keys ");
    await stage.press("escape");
    await stage.settle();

    await stage.press("ctrl+k", "t", "escape");
    await stage.press("/");
    const tray = await stage.until("reload the sessions");
    await stage.capture("entity-tray");
    const refreshRow = rowOf(tray, "reload the sessions");
    await stage.hover(6, refreshRow);
    const hovered = await stage.until("▸ refresh");
    assert.ok(hovered.includes("▸ refresh"), "hover moves the tray selection");
    await stage.click(6, refreshRow);
    await stage.settle();
    const clicked = await stage.capture("after-click");
    assert.ok(
      !clicked.includes("reload the sessions"),
      "clicking a row runs it and closes the tray",
    );

    await stage.press("/");
    const reopened = await stage.until("reload the sessions");
    const bodyRow = rowOf(reopened, "no sessions yet");
    await stage.click(6, bodyRow);
    await stage.settle();
    const dismissed = await stage.capture("outside-dismissed");
    assert.ok(
      !dismissed.includes("reload the sessions"),
      "a press outside the rows dismisses the tray",
    );

    await stage.quit();
  },
};
