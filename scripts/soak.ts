#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Agent, type EngineEvents, type EventBus } from "../packages/engine/src/index.ts";
import { runScenario } from "./e2e/harness.ts";
import type { Scenario, Stage } from "./e2e/scenario.ts";
import {
  defaultThresholds,
  formatReport,
  judgeSoak,
  percentile,
  type SoakSample,
  type SoakThresholds,
} from "./soak/budget.ts";
import { noteTool, replyMarker, SoakProvider } from "./soak/provider.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    turns: { type: "string", default: "500" },
    "pane-cycle": { type: "string", default: "10" },
    "sample-every": { type: "string", default: "25" },
    "tool-every": { type: "string", default: "7" },
    "render-p95-ms": { type: "string", default: String(defaultThresholds.renderP95Ms) },
    "heap-ratio": { type: "string", default: String(defaultThresholds.heapGrowthRatio) },
    "rss-ratio": { type: "string", default: String(defaultThresholds.rssGrowthRatio) },
    out: { type: "string", default: "artifacts/soak" },
  },
});

const turns = positiveInteger(values.turns, "--turns");
const paneCycle = positiveInteger(values["pane-cycle"], "--pane-cycle");
const sampleEvery = positiveInteger(values["sample-every"], "--sample-every");
const toolEvery = positiveInteger(values["tool-every"], "--tool-every");
const thresholds: SoakThresholds = {
  ...defaultThresholds,
  warmupTurns: Math.min(defaultThresholds.warmupTurns, Math.max(1, Math.floor(turns / 4))),
  renderP95Ms: Number(values["render-p95-ms"]),
  heapGrowthRatio: Number(values["heap-ratio"]),
  rssGrowthRatio: Number(values["rss-ratio"]),
};

const soakEvents: readonly (keyof EngineEvents)[] = [
  "turn.started",
  "turn.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "turn.completed",
  "turn.interrupted",
  "gate.permission",
  "context.injected",
  "engine.error",
];
const provider = new SoakProvider(toolEvery);
const buses = new Set<EventBus>();
const samples: SoakSample[] = [];
const renderWindow: number[] = [];
const fatalGuardsBefore = fatalGuardListeners();
let panesAlive = 1;

const soak: Scenario = {
  name: "soak",
  description: `${turns} turns, a pane cycle every ${paneCycle}, a tool call every ${toolEvery}`,
  agentFactory: (guard, history, seams) => {
    const agent = new Agent({
      provider,
      tools: [noteTool],
      guard,
      permissions: () => "allow",
      ...(history !== undefined && { history }),
      ...(seams?.bus !== undefined && { bus: seams.bus }),
    });
    buses.add(agent.bus);
    return agent;
  },
  run: async (stage) => {
    await stage.settle();
    await stage.until("session-1");
    for (let turn = 1; turn <= turns; turn += 1) {
      if (turn > 1 && turn % paneCycle === 1) await cyclePane(stage);
      await stage.type(`ping ${turn}`);
      await stage.press("enter");
      await stage.until(replyMarker(turn));
      renderWindow.push(await stage.renderOnce());
      if (turn % sampleEvery === 0 || turn === turns) samples.push(await sampleAt(turn));
    }
    await stage.quit();
  },
};

const result = await runScenario(soak, {
  outRoot: resolve(values.out),
  size: { width: 120, height: 32 },
});
const residue = {
  busesWithListeners: busesWithListeners(),
  fatalGuardListeners: Math.max(0, fatalGuardListeners() - fatalGuardsBefore),
};
const verdict = judgeSoak(samples, residue, thresholds);
const report = formatReport(verdict, samples);
console.log(`\nsoak · ${soak.description} · ${provider.turnsServed()} turns served`);
console.log(report);
for (const line of residueDetail()) console.log(line);
await Bun.write(
  `${result.artifactDir}/report.json`,
  JSON.stringify({ description: soak.description, thresholds, samples, residue, verdict }, null, 2),
);
if (!result.ok) {
  console.error(`harness failure: ${result.error}`);
  process.exit(1);
}
process.exit(verdict.ok ? 0 : 1);

async function cyclePane(stage: Stage): Promise<void> {
  await stage.press("ctrl+k", "s", "escape");
  await stage.settle();
  panesAlive += 1;
  await stage.press("ctrl+k", "h", "escape");
  await stage.type("/exit");
  await stage.press("enter");
  await stage.settle();
  panesAlive -= 1;
}

async function sampleAt(turn: number): Promise<SoakSample> {
  Bun.gc(true);
  const memory = process.memoryUsage();
  const renderMs = percentile(renderWindow.splice(0), 95);
  return {
    turn,
    panes: panesAlive,
    rssBytes: memory.rss,
    heapBytes: memory.heapUsed,
    renderMs,
    busesWithListeners: busesWithListeners(),
  };
}

function busesWithListeners(): number {
  return [...buses].filter((bus) => bus.listenerCount() > 0).length;
}

function residueDetail(): string[] {
  return [...buses]
    .map((bus, index) => ({ index, bus }))
    .filter(({ bus }) => bus.listenerCount() > 0)
    .map(({ index, bus }) => {
      const kept = soakEvents
        .filter((event) => bus.listenerCount(event) > 0)
        .map((event) => `${event}×${bus.listenerCount(event)}`)
        .join(" ");
      return `  agent ${index + 1} still listens: ${kept}`;
    });
}

function fatalGuardListeners(): number {
  return process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection");
}

function positiveInteger(raw: string | undefined, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`${flag} wants a positive integer, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return parsed;
}
