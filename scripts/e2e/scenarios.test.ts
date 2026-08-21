import { describe, expect, it } from "vitest";
import { kebabCase } from "./artifacts.ts";
import { defaultScenarios, scenarioNamed, scenarios } from "./scenarios.ts";

describe("scenario registry", () => {
  it("registers the full scenario pack in workflow order", () => {
    expect(scenarios.map((scenario) => scenario.name)).toEqual([
      "cold-start",
      "first-conversation",
      "tiling-tour",
      "chroma-sweep",
      "page-tiers",
      "session-lifecycle",
      "long-session",
      "discovery",
      "defect-repros",
      "pointer-tour",
      "live-playground",
    ]);
  });

  it("keeps manual scenarios out of the default pack", () => {
    expect(scenarioNamed("live-playground")?.manual).toBe(true);
    expect(defaultScenarios().map((scenario) => scenario.name)).toEqual([
      "cold-start",
      "first-conversation",
      "tiling-tour",
      "chroma-sweep",
      "page-tiers",
      "session-lifecycle",
      "long-session",
      "discovery",
      "defect-repros",
      "pointer-tour",
    ]);
  });

  it("snapshots the session dir before boot for the live gentleness check", () => {
    expect(scenarioNamed("live-playground")?.beforeBoot).toBeDefined();
    for (const scenario of defaultScenarios()) {
      expect(scenario.manual).toBeUndefined();
    }
  });

  it("gives every scenario a unique kebab-case name and a description", () => {
    const names = scenarios.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
    for (const scenario of scenarios) {
      expect(scenario.name).toBe(kebabCase(scenario.name));
      expect(scenario.description.length).toBeGreaterThan(0);
      expect(typeof scenario.run).toBe("function");
    }
  });

  it("looks scenarios up by exact name only", () => {
    expect(scenarioNamed("tiling-tour")?.name).toBe("tiling-tour");
    expect(scenarioNamed("tiling")).toBeUndefined();
  });

  it("scripts a mutating write turn for the first conversation", () => {
    const scenario = scenarioNamed("first-conversation");
    const deltas = scenario?.turns?.flat() ?? [];
    expect(deltas.some((delta) => delta.type === "tool-call")).toBe(true);
    expect(scenario?.files).toHaveProperty(["notes.txt"]);
    expect(scenario?.tools).toBeDefined();
  });

  it("boots cold-start without any provider", () => {
    expect(scenarioNamed("cold-start")?.provider).toBe("none");
    for (const scenario of scenarios.filter((entry) => entry.name !== "cold-start")) {
      expect(scenario.provider).toBeUndefined();
    }
  });

  it("wires discovery an honest preset port over the real preset data", async () => {
    const factory = scenarioNamed("discovery")?.presets;
    expect(factory).toBeDefined();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateDir = mkdtempSync(join(tmpdir(), "keywork-presets-"));
    try {
      const port = factory?.(stateDir);
      expect(port?.names()).toEqual(["careful", "standard", "open"]);
      expect(port?.active()).toBe("standard");
      expect(port?.requiresConfirmation("open")).toBe(true);
      expect(port?.requiresConfirmation("careful")).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
