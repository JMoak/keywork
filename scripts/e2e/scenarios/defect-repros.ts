import { strict as assert } from "node:assert";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Scenario, Stage } from "../scenario.ts";

export const defectRepros: Scenario = {
  name: "defect-repros",
  description:
    "C35 pane-overlap evidence at eight panes; C36 lazy sessions keep the litter at zero",
  run: async (stage) => {
    await stage.settle();
    await stage.press("ctrl+k", "s", "s", "s", "s", "s", "s", "s", "escape");
    await stage.settle();
    await stage.capture("eight-panes-overlap");

    await stage.quit();
    const report = sessionLitterReport(stage);
    const path = stage.evidence("evidence-session-files.txt", report);
    assert.ok(existsSync(path), "the session-litter evidence file was written");
    assert.ok(
      report.startsWith("0 session files"),
      "splitting eight panes and quitting must mint zero session files",
    );
  },
};

function sessionLitterReport(stage: Stage): string {
  const files = readdirSync(stage.sessionDir).filter((name) => name.endsWith(".jsonl"));
  const listing = files.map(
    (name) => `${name}  ${statSync(join(stage.sessionDir, name)).size} bytes`,
  );
  return [
    `${files.length} session files after splitting eight panes and quitting with nothing typed`,
    ...listing,
    "",
  ].join("\n");
}
