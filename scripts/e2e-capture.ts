#!/usr/bin/env bun
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { type CaptureArgs, liveModeRefusal, parseCaptureArgs } from "./e2e/cli-args.ts";
import { runScenario, type ScenarioResult } from "./e2e/harness.ts";
import { liveWorld } from "./e2e/live.ts";
import type { Scenario } from "./e2e/scenario.ts";
import { defaultScenarios, scenarioNamed, scenarios } from "./e2e/scenarios.ts";

const parsed = parseCaptureArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error(
    "usage: bun scripts/e2e-capture.ts [scenario…] [--size 120x32] [--out dir] [--cwd dir --live] [--list] [--update-goldens]",
  );
  process.exit(2);
}

if (parsed.args.list) {
  for (const scenario of scenarios) {
    const marker = scenario.manual === true ? "  [manual: run with --cwd <dir> --live]" : "";
    console.log(`${scenario.name}: ${scenario.description}${marker}`);
  }
  process.exit(0);
}

const refusal = liveModeRefusal(parsed.args);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(1);
}

const liveCwd = liveTargetDir(parsed.args);
const chosen = selectScenarios(parsed.args.scenarios, liveCwd !== undefined);
if (liveCwd !== undefined) printLiveReminder(liveCwd);

const results: ScenarioResult[] = [];
for (const scenario of chosen) {
  console.log(`▶ ${scenario.name}`);
  results.push(
    await runScenario(scenario, {
      outRoot: resolve(parsed.args.out),
      size: parsed.args.size,
      updateGoldens: parsed.args.updateGoldens,
      ...(liveCwd !== undefined && { world: liveWorld(liveCwd) }),
    }),
  );
}

const nameWidth = Math.max(...results.map((result) => result.name.length));
for (const result of results) {
  const status = result.ok ? "pass" : "fail";
  const goldenNote =
    result.goldens.length === 0
      ? ""
      : ` (${result.goldens.length} goldens ${parsed.args.updateGoldens ? "written" : "verified"})`;
  const detail = result.ok
    ? `${result.captures.length} captures${goldenNote} → ${result.artifactDir}`
    : (result.error ?? "unknown failure");
  console.log(`${status}  ${result.name.padEnd(nameWidth)}  ${detail}`);
}
if (liveCwd !== undefined) printLiveReminder(liveCwd);
process.exit(results.every((result) => result.ok) ? 0 : 1);

function liveTargetDir(args: CaptureArgs): string | undefined {
  if (!args.live || args.cwd === undefined) return undefined;
  const cwd = resolve(args.cwd);
  if (!isDirectory(cwd)) {
    console.error(`--cwd is not a directory: ${cwd}`);
    process.exit(1);
  }
  return cwd;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function selectScenarios(names: readonly string[], live: boolean): readonly Scenario[] {
  if (names.length === 0) return defaultScenarios();
  return names.map((name) => {
    const scenario = scenarioNamed(name);
    if (scenario === undefined) {
      console.error(`unknown scenario: ${name} (try --list)`);
      process.exit(2);
    }
    if (scenario.manual === true && !live) {
      console.error(`${name} is manual-only: run it with --cwd <dir> --live`);
      process.exit(1);
    }
    return scenario;
  });
}

function printLiveReminder(cwd: string): void {
  console.warn("");
  console.warn(`⚠  LIVE RUN against ${cwd}`);
  console.warn("⚠  Captured frames and SVGs may contain real transcript content.");
  console.warn("⚠  Review everything under the artifact dir before committing or sharing it.");
  console.warn("");
}
