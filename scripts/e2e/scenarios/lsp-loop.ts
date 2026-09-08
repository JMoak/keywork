import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtInLanguageServers,
  diagnosticsObserver,
  editTool,
  type LanguagePort,
  languagePort,
  type TurnDelta,
  textTurn,
  toolScope,
} from "../../../packages/engine/src/index.ts";
import { installLanguageServerShim } from "../../../packages/engine/src/testing/index.ts";
import { occurrences } from "../frame-queries.ts";
import type { Scenario, Stage } from "../scenario.ts";

const askRowMarker = "[y] allow  [a] always  [n] deny";
const blockHeader = "diagnostics (typescript) · 1 error · 1 warning";
const blockRow = "cache.ts:1:22 · Cannot find name 'BROKEN'.";
const calmHeader = /│ session-1 +│/;
const frozenClock = (): number => Date.parse("2026-09-06T12:00:00.000Z");

let port: LanguagePort | undefined;

function editTurn(callId: string, lead: string, oldText: string, newText: string): TurnDelta[] {
  return [
    { type: "text", text: lead },
    {
      type: "tool-call",
      call: {
        type: "tool-call",
        callId,
        name: "edit",
        arguments: { path: "cache.ts", oldText, newText },
      },
    },
    { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
  ];
}

export const lspLoop: Scenario = {
  name: "lsp-loop",
  description:
    "114/F4b: an edit that introduces BROKEN carries the diagnostics block inside its tool result; the fix that removes it carries none",
  files: { "cache.ts": "export const total = 1;\n" },
  app: { clock: frozenClock },
  tools: (workspaceDir) => {
    const shimDir = mkdtempSync(join(tmpdir(), "keywork-lsp-shim-"));
    installLanguageServerShim(shimDir, "typescript-language-server", "basic");
    const scope = toolScope(workspaceDir);
    port = languagePort(scope, { servers: builtInLanguageServers, searchPath: shimDir });
    return [editTool(scope, diagnosticsObserver(port, { cwd: workspaceDir }))];
  },
  turns: [
    editTurn("call-1", "Renaming the constant's initializer to BROKEN.", "1", "BROKEN"),
    textTurn("The server flagged BROKEN; I will put a real value back."),
    editTurn("call-2", "Restoring a real value.", "BROKEN", "2"),
    textTurn("Clean now, no diagnostics on cache.ts."),
  ],
  goldens: ["broken-edit", "clean-edit"],
  run: async (stage) => {
    await stage.settle();

    await stage.type("set total to BROKEN in cache.ts");
    await stage.press("enter");
    await stage.until(askRowMarker);
    await stage.press("y");
    const settled = await stage.until("I will put a real value back.");
    assert.ok(settled.includes("edit cache.ts"), "the tool row names its verb and subject");
    assert.ok(!settled.includes(blockHeader), "tool detail starts folded");
    await stage.until(calmHeader);
    await discloseLatestToolRow(stage);
    const broken = await stage.until(blockRow);
    assert.ok(broken.includes(blockHeader), "the block header names the language and counts");
    assert.ok(
      broken.includes("Replaced 1 occurrence in cache.ts"),
      "the confirmation line precedes the block",
    );
    await stage.capture("broken-edit");
    await foldToolRow(stage);

    await stage.type("now fix it");
    await stage.press("enter");
    await stage.until(askRowMarker);
    await stage.press("y");
    await stage.until("Clean now, no diagnostics on cache.ts.");
    await stage.until(calmHeader);
    await discloseLatestToolRow(stage);
    const clean = await stage.until(/Replaced 1 occurrence in cache\.ts\s*│\s*$/m);
    assert.equal(
      occurrences(clean, "diagnostics (typescript)"),
      0,
      "the clean edit carries no block",
    );
    await stage.capture("clean-edit");

    await stage.quit();
    await port?.dispose();
  },
};

async function discloseLatestToolRow(stage: Stage): Promise<void> {
  await stage.press("shift+tab");
  await stage.until("disclose · tab toggles");
  await stage.press("tab");
}

async function foldToolRow(stage: Stage): Promise<void> {
  await stage.press("escape", "tab");
  await stage.settle();
}
