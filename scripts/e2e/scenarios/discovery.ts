import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPresetSwitch, presetsPortFor } from "../../../packages/cli/src/presets.ts";
import type { PresetsPort } from "../../../packages/tui/src/index.ts";
import type { Scenario } from "../scenario.ts";

export const discovery: Scenario = {
  name: "discovery",
  description: "palette, slash autocomplete, help overlay, preset picker",
  presets: harnessPresets,
  goldens: ["quick-open", "palette", "slash-completions", "help-overlay", "preset-picker"],
  run: async (stage) => {
    await stage.settle();

    await stage.press("ctrl+p");
    const quickOpen = await stage.until("jump to this pane");
    assert.ok(!quickOpen.includes("▸ split"), "quick open holds no command rows");
    await stage.capture("quick-open");

    await stage.type(">");
    const palette = await stage.until("▸ split");
    assert.ok(palette.includes(" commands "), "the > prefix flips the overlay to command mode");
    assert.ok(palette.includes("open a new session pane"), "palette rows carry descriptions");
    assert.ok(palette.includes("zoom the focused pane"), "palette lists command rows");
    assert.ok(!palette.includes("jump to this pane"), "command mode hides the jump rows");
    await stage.capture("palette");
    await stage.press("escape");

    await stage.type("/ex");
    await stage.settle();
    const completions = await stage.until("exit-all");
    assert.ok(completions.includes("exit"), "slash input ranks the exit commands");
    await stage.capture("slash-completions");
    await stage.press("backspace", "backspace", "backspace");

    await stage.press("ctrl+k", "/");
    await stage.until(" keywork keys ");
    await stage.capture("help-overlay");
    await stage.press("escape");

    await stage.type("/preset");
    await stage.press("enter");
    const picker = await stage.until("standard · active");
    assert.ok(picker.includes("careful") && picker.includes("open"), "picker lists every preset");
    await stage.capture("preset-picker");
    await stage.press("escape");

    await stage.quit();
  },
};

function harnessPresets(stateDir: string): PresetsPort {
  const stateFile = join(stateDir, "permissions.json");
  return presetsPortFor(
    createPresetSwitch({
      initial: undefined,
      persist: async (permissions) => {
        writeFileSync(stateFile, `${JSON.stringify(permissions, null, 2)}\n`);
      },
    }),
  );
}
