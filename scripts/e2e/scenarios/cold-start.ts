import { strict as assert } from "node:assert";
import type { Scenario } from "../scenario.ts";

export const coldStart: Scenario = {
  name: "cold-start",
  description: "boot with no provider → guidance in the conversation pane → real quit path",
  provider: "none",
  goldens: ["no-provider-guidance"],
  run: async (stage) => {
    await stage.settle();
    const boot = await stage.until("no model bound");
    assert.ok(boot.includes("/connect adds a provider"), "guidance teaches /connect and waits");
    assert.ok(boot.includes("/model picks one"), "guidance teaches /model and waits");
    await stage.capture("no-provider-guidance");
    const code = await stage.quit();
    assert.equal(code, 0, "the real exit path reaches the exit seam cleanly");
  },
};
