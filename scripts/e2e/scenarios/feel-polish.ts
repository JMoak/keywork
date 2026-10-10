import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../scenario.ts";

const editorScript = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
writeFileSync(file, readFileSync(file, "utf8") + " edited outside\n");
`;

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export const feelPolish: Scenario = {
  name: "feel-polish",
  description:
    "ctrl+g round-trips the draft through $VISUAL; an image path pastes as a chip; /bug writes a local bundle",
  goldens: ["after-editor", "image-chip"],
  beforeBoot: (world) => {
    const script = join(world.workspaceDir, "edit-outside.ts");
    writeFileSync(script, editorScript);
    writeFileSync(join(world.workspaceDir, "shot.png"), onePixelPng);
    process.env.VISUAL = `bun ${script}`;
  },
  run: async (stage) => {
    await stage.settle();

    await stage.type("draft");
    await stage.press("ctrl+g");
    await stage.until("draft edited outside");
    await stage.settle();
    await stage.capture("after-editor");

    await stage.paste(join(stage.workspaceDir, "shot.png"));
    await stage.until("[image #1, png 70 B]");
    await stage.capture("image-chip");

    await stage.press(...Array.from({ length: 60 }, () => "backspace"));
    await stage.type("/bug");
    await stage.press("return");
    await stage.until("bug report written");
    const reports = join(stage.workspaceDir, "..", ".keywork", "bug-reports");
    const [name] = readdirSync(reports);
    assert.ok(name !== undefined && /^bug-.*\.json$/.test(name), "the bundle lands on disk");
    const path = join(reports, name);
    const bundle = JSON.parse(readFileSync(path, "utf8")) as {
      events: unknown[];
      terminal: unknown;
    };
    assert.ok(Array.isArray(bundle.events), "the bundle carries the recent events");
    assert.ok(bundle.terminal !== undefined, "the bundle names the terminal");

    await stage.quit();
  },
};
