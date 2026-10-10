import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenario } from "./harness.ts";
import type { Scenario } from "./scenario.ts";

const probe: Scenario = {
  name: "ctrlc-probe",
  description: "ctrl+c clears the prompt and keeps the app alive",
  files: {},
  turns: [],
  run: async (stage) => {
    await stage.settle();
    await stage.capture("typed-before");
    await stage.type("hello there");
    await stage.capture("typed");
    // await stage.press("ctrl+c");
    await stage.settle();
    const cleared = await stage.capture("cleared");
    if (cleared.includes("hello there")) throw new Error("prompt not cleared");
    // await stage.press("up");
    await stage.settle();
    const restored = await stage.capture("restored");
    if (!restored.includes("hello there")) throw new Error(`draft not restored:\n${restored}`);
  },
};

const result = await runScenario(probe, {
  outRoot: mkdtempSync(join(tmpdir(), "kw-probe-")),
  size: { width: 120, height: 32 },
});
console.log(result.ok ? "PROBE OK" : `PROBE FAIL: ${result.error}`);
process.exit(result.ok ? 0 : 1);
