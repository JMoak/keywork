import { describe, expect, it } from "vitest";
import { kebabCase } from "../artifacts.ts";
import { committedGoldenRoot, goldenTree } from "../goldens.ts";
import { defaultScenarios, scenarioNamed, scenarios } from "./index.ts";

describe("scenario registry", () => {
  it("keeps manual scenarios out of the default pack", () => {
    expect(scenarioNamed("live-playground")?.manual).toBe(true);
    expect(defaultScenarios().map((scenario) => scenario.name)).toEqual([
      "cold-start",
      "first-conversation",
      "tiling-tour",
      "lsp-loop",
      "chroma-sweep",
      "chrome-states",
      "chrome-states-ascii",
      "chrome-states-dim-on",
      "chrome-states-dim-off",
      "focus-corners-frame",
      "focus-corners-grid",
      "focus-corners-frame-ascii",
      "focus-corners-grid-ascii",
      "focus-repaint",
      "page-tiers",
      "masthead-ladder",
      "session-lifecycle",
      "delegation",
      "long-session",
      "gauge-ramp",
      "gauge-steps",
      "gauge-tile",
      "gauge-bare",
      "gauge-bar",
      "elevation-arc-stamps",
      "elevation-turn-age",
      "elevation-scroll-map",
      "elevation-chrome",
      "arcs",
      "arc-fold",
      "bots-tour",
      "bots-tour-ascii",
      "memory-browser",
      "memory-airlock-tail",
      "garden-heat-lead",
      "garden-heat-ink",
      "status-tips",
      "discovery",
      "defect-repros",
      "injection-citizenship",
      "pointer-tour",
      "pointer-off",
      "tray-tour",
      "terminal-mirror",
      "terminal-hygiene",
      "file-links",
      "file-links-off",
      "diff-pane",
      "feel-polish",
      "extensions-tour",
    ]);
  });

  it("snapshots the session dir before boot for the live gentleness check", () => {
    expect(scenarioNamed("live-playground")?.beforeBoot).toBeDefined();
    for (const scenario of defaultScenarios()) {
      expect(scenario.manual).toBeUndefined();
    }
  });

  it("commits exactly the goldens the scenarios declare, keyed by step name", () => {
    const declared = Object.fromEntries(
      scenarios
        .filter((scenario) => (scenario.goldens ?? []).length > 0)
        .map((scenario) => [scenario.name, [...(scenario.goldens ?? [])].map(kebabCase).sort()]),
    );
    expect(goldenTree(committedGoldenRoot)).toEqual(declared);
  });
});
