import { strict as assert } from "node:assert";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../scenario.ts";

type SessionFileListing = ReadonlyMap<string, number>;

interface SessionDirDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly resized: readonly string[];
  readonly report: string;
}

let filesBeforeBoot: SessionFileListing = new Map();

export const livePlayground: Scenario = {
  name: "live-playground",
  description: "restored layout and session tree over real accumulated state, then a clean quit",
  manual: true,
  beforeBoot: ({ sessionDir }) => {
    filesBeforeBoot = sessionFileListing(sessionDir);
  },
  run: async (stage) => {
    await stage.settle();
    const restored = await stage.capture("restored-layout");
    assert.ok(restored.includes("session"), "the saved layout revives session panes");

    await stage.press("ctrl+k", "t", "escape");
    const overview = await stage.until("session tree");
    assert.ok(overview.includes("sessions"), "the overview lists real sessions");
    await stage.settle();
    await stage.capture("sessions-overview-over-history");

    await stage.press("l");
    const tree = await stage.until("●");
    assert.ok(tree.includes("●"), "drilling in shows entries from real history");
    await stage.settle();
    await stage.capture("session-entries-over-history");

    await stage.quit();
    const delta = sessionDirDelta(filesBeforeBoot, sessionFileListing(stage.sessionDir));
    stage.evidence("evidence-state-delta.txt", delta.report);
    assert.equal(delta.removed.length, 0, "a live pass must never remove session files");
  },
};

function sessionFileListing(dir: string): SessionFileListing {
  if (!existsSync(dir)) return new Map();
  const listing = new Map<string, number>();
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".jsonl"))) {
    listing.set(name, statSync(join(dir, name)).size);
  }
  return listing;
}

function sessionDirDelta(before: SessionFileListing, after: SessionFileListing): SessionDirDelta {
  const added = [...after.keys()].filter((name) => !before.has(name));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const resized = [...after.keys()].filter(
    (name) => before.has(name) && before.get(name) !== after.get(name),
  );
  const report = [
    `session files before boot: ${before.size} · after quit: ${after.size}`,
    added.length === 0
      ? "added: none · restore revived sessions without minting files"
      : `added: ${added.length} · PRODUCT FINDING: a plain open/quit cycle minted session files`,
    ...added.map((name) => `  + ${name}  ${after.get(name)} bytes`),
    removed.length === 0 ? "removed: none" : `removed: ${removed.length}`,
    ...removed.map((name) => `  - ${name}  ${before.get(name)} bytes`),
    resized.length === 0 ? "resized: none" : `resized: ${resized.length}`,
    ...resized.map((name) => `  ~ ${name}  ${before.get(name)} → ${after.get(name)} bytes`),
    "",
  ].join("\n");
  return { added, removed, resized, report };
}
