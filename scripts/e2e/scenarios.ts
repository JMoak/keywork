import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPresetSwitch, isPresetName } from "../../packages/cli/src/presets.ts";
import { type Tool, textTurn, writeTool } from "../../packages/engine/src/index.ts";
import { presetOrder, requiresConfirmation } from "../../packages/shared/src/index.ts";
import type { PresetsPort } from "../../packages/tui/src/index.ts";
import type { Scenario, Stage } from "./scenario.ts";

const notesBefore = "alpha\nbeta\ngamma\n";
const notesAfter = "alpha\nBETA\ngamma\n";
const askRowMarker = "[y] allow  [a] always  [n] deny";

const listTool: Tool = {
  name: "list",
  description: "lists workspace files",
  parameters: { type: "object" },
  execute: async () => "total 4\ndrwxr-xr-x 2 dev dev 4096 .",
};

export const scenarios: readonly Scenario[] = [
  coldStart(),
  firstConversation(),
  tilingTour(),
  sessionLifecycle(),
  discovery(),
  defectRepros(),
  livePlayground(),
];

export function scenarioNamed(name: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.name === name);
}

export function defaultScenarios(): readonly Scenario[] {
  return scenarios.filter((scenario) => scenario.manual !== true);
}

function coldStart(): Scenario {
  return {
    name: "cold-start",
    description: "boot with no provider → guidance in the conversation pane → real quit path",
    provider: "none",
    run: async (stage) => {
      await stage.settle();
      const boot = await stage.until("no provider · set");
      assert.ok(boot.includes("set KEYWORK_OPENROUTER_API_KEY"), "guidance names the fix");
      await stage.capture("no-provider-guidance", { golden: true });
      const code = await stage.quit();
      assert.equal(code, 0, "the real exit path reaches the exit seam cleanly");
    },
  };
}

function firstConversation(): Scenario {
  return {
    name: "first-conversation",
    description: "prompt → streamed reply → write ask with diff → approve → /undo → /redo",
    files: { "notes.txt": notesBefore },
    tools: (workspaceDir) => [writeTool(workspaceDir)],
    turns: [
      [
        { type: "text", text: "Shouting the middle line of notes.txt now." },
        {
          type: "tool-call",
          call: {
            type: "tool-call",
            callId: "call-1",
            name: "write",
            arguments: { path: "notes.txt", content: notesAfter },
          },
        },
        { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      textTurn("All set — beta is BETA now."),
    ],
    run: async (stage) => {
      await stage.settle();
      await stage.capture("boot");

      await stage.type("please shout the middle line of notes.txt");
      await stage.press("enter");
      const ask = await stage.until(askRowMarker);
      assert.ok(ask.includes("Shouting the middle line"), "streamed reply precedes the ask");
      assert.ok(ask.includes("- beta"), "diff preview shows the removed line");
      assert.ok(ask.includes("+ BETA"), "diff preview shows the added line");
      await stage.capture("ask-with-diff");

      await stage.press("y");
      const settled = await stage.until("All set — beta is BETA now.");
      assert.ok(settled.includes("✓ write"), "tool settles to its ✓ line");
      assert.equal(workspaceRead(stage, "notes.txt"), notesAfter);
      await stage.until("─ session-1 ─");
      await stage.capture("turn-complete");

      await stage.type("/undo");
      await stage.press("enter");
      await stage.until("files put back");
      assert.equal(workspaceRead(stage, "notes.txt"), notesBefore);
      await stage.capture("undo-notice");

      await stage.type("/redo");
      await stage.press("enter");
      await stage.until("files redone");
      assert.equal(workspaceRead(stage, "notes.txt"), notesAfter);
      await stage.capture("redo-notice");

      await stage.quit();
    },
  };
}

function tilingTour(): Scenario {
  return {
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
      await stage.capture("session-tree");

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
}

function sessionLifecycle(): Scenario {
  const reply = "Noted — the plan is recorded.";
  const toolProse = "Counting the files now.";
  const toolVerdict = "There are 4 files here.";
  const settledToolLine = "✓ list — total 4";
  return {
    name: "session-lifecycle",
    description:
      "converse → sessions overview → drill in → label → fork → live overview → switchboard enter → tool turn → quit → relaunch restores layout, sessions, and clean tool replay",
    tools: () => [listTool],
    turns: [
      textTurn(reply),
      [
        {
          type: "tool-call",
          call: { type: "tool-call", callId: "call-list", name: "list", arguments: {} },
        },
        { type: "text", text: toolProse },
        { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      textTurn(toolVerdict),
    ],
    run: async (stage) => {
      await stage.settle();
      await stage.type("plan the fix");
      await stage.press("enter");
      await stage.until(reply);
      await stage.until("─ session-1 ─");
      await stage.capture("conversation");

      await stage.press("ctrl+k", "t", "escape");
      const overviewOne = await stage.until("▓ plan the fix · now");
      assert.ok(overviewOne.includes("session tree · 1 session"), "the overview counts its rows");
      await stage.capture("sessions-overview-one");

      await stage.press("l");
      await stage.until("● user: plan the fix");
      await stage.capture("entries-drilled");

      await stage.press("shift+l");
      await stage.type("keep");
      await stage.press("enter");
      await stage.until("[keep]");
      await stage.capture("tree-labeled");

      await stage.press("j", "f");
      await stage.until("session-2");
      await stage.settle();
      const forked = await stage.capture("forked-layout");
      assert.equal(paneTitleCount(forked), 2, "the fork opens a second session pane");

      await stage.press("ctrl+k", "t", "escape");
      const overview = await stage.until("session tree · 2 sessions");
      assert.equal(
        occurrences(overview, "▓ plan the fix · now"),
        2,
        "the fork lands in the overview unprompted, both sessions marked attached",
      );
      await stage.capture("sessions-overview-live");

      await stage.press("enter");
      await stage.settle();
      await stage.type("count the files");
      await stage.press("enter");
      await stage.until(settledToolLine);
      await stage.until(toolVerdict);
      await stage.settle();
      await stage.capture("tool-turn");

      await stage.relaunch();
      await stage.until(reply);
      await stage.until(settledToolLine);
      await stage.settle();
      const restored = await stage.capture("relaunched-restored");
      assert.equal(paneTitleCount(restored), 2, "both session panes come back");
      assert.ok(
        restored.includes("session tree · 2 sessions"),
        "the persisted tree pane revives into the sessions overview",
      );
      assert.ok(restored.includes("plan the fix"), "the revived session replays the prompt");
      assert.ok(restored.includes(toolVerdict), "the closing prose replays after the tool entry");
      const proseAt = restored.indexOf(toolProse);
      const toolAt = restored.indexOf(settledToolLine);
      assert.ok(
        proseAt >= 0 && proseAt < toolAt,
        "replay keeps the streamed prose before the settled tool line, as it rendered live",
      );
      assert.ok(
        !restored.includes(`${toolProse}${toolVerdict}`),
        "tool-entry replay never merges prose across turns",
      );
      await stage.quit();
    },
  };
}

function discovery(): Scenario {
  return {
    name: "discovery",
    description: "palette, slash autocomplete, help overlay, preset picker",
    presets: harnessPresets,
    run: async (stage) => {
      await stage.settle();

      await stage.press("ctrl+p");
      const palette = await stage.until("▸ split");
      assert.ok(palette.includes("open a new session pane"), "palette rows carry descriptions");
      assert.ok(palette.includes("zoom the focused pane"), "palette lists command rows");
      await stage.capture("palette", { golden: true });
      await stage.press("escape");

      await stage.type("/ex");
      await stage.settle();
      const completions = await stage.until("exit-all");
      assert.ok(completions.includes("exit"), "slash input ranks the exit commands");
      await stage.capture("slash-completions", { golden: true });
      await stage.press("backspace", "backspace", "backspace");

      await stage.press("ctrl+k", "/");
      await stage.until(" keywork keys ");
      await stage.capture("help-overlay", { golden: true });
      await stage.press("escape");

      await stage.type("/preset");
      await stage.press("enter");
      const picker = await stage.until("standard · active");
      assert.ok(picker.includes("careful") && picker.includes("open"), "picker lists every preset");
      await stage.capture("preset-picker", { golden: true });
      await stage.press("escape");

      await stage.quit();
    },
  };
}

function defectRepros(): Scenario {
  return {
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
}

function livePlayground(): Scenario {
  let filesBeforeBoot: SessionFileListing = new Map();
  return {
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
}

type SessionFileListing = ReadonlyMap<string, number>;

interface SessionDirDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly resized: readonly string[];
  readonly report: string;
}

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
      ? "added: none — restore revived sessions without minting files"
      : `added: ${added.length} — PRODUCT FINDING: a plain open/quit cycle minted session files`,
    ...added.map((name) => `  + ${name}  ${after.get(name)} bytes`),
    removed.length === 0 ? "removed: none" : `removed: ${removed.length}`,
    ...removed.map((name) => `  - ${name}  ${before.get(name)} bytes`),
    resized.length === 0 ? "resized: none" : `resized: ${resized.length}`,
    ...resized.map((name) => `  ~ ${name}  ${before.get(name)} → ${after.get(name)} bytes`),
    "",
  ].join("\n");
  return { added, removed, resized, report };
}

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

function harnessPresets(stateDir: string): PresetsPort {
  const stateFile = join(stateDir, "permissions.json");
  const presets = createPresetSwitch({
    initial: undefined,
    persist: async (permissions) => {
      writeFileSync(stateFile, `${JSON.stringify(permissions, null, 2)}\n`);
    },
  });
  return {
    names: () => presetOrder,
    active: () => presets.active(),
    requiresConfirmation: (name) =>
      isPresetName(name) && requiresConfirmation(presets.active(), name),
    apply: async (name) => {
      if (isPresetName(name)) await presets.apply(name);
    },
  };
}

function workspaceRead(stage: Stage, path: string): string {
  return readFileSync(join(stage.workspaceDir, path), "utf8");
}

function paneTitleCount(frame: string): number {
  return frame.split("session-").length - 1;
}

function occurrences(frame: string, marker: string): number {
  return frame.split(marker).length - 1;
}

function columnOf(frame: string, marker: string): number {
  const line = frame.split("\n").find((candidate) => candidate.includes(marker));
  assert.ok(line !== undefined, `no frame line contains "${marker}"`);
  return line.indexOf(marker);
}
