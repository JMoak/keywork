import { describe, expect, it } from "vitest";
import type { Scenario } from "./scenario.ts";
import { selectScenarios } from "./selection.ts";

const available: readonly Scenario[] = [
  { name: "cold-start", description: "", run: async () => {} },
  { name: "long-session", description: "", run: async () => {} },
  { name: "file-links-on", description: "", run: async () => {} },
  { name: "live-playground", description: "", manual: true, run: async () => {} },
];

describe("selectScenarios", () => {
  it("keeps long-session in the full default pack and excludes manual scenarios", () => {
    expect(selectScenarios(available, { scenarios: [], exclude: [], live: false })).toEqual({
      ok: true,
      scenarios: available.slice(0, 3),
    });
  });

  it("excludes the requested scenario without changing the remaining order", () => {
    expect(
      selectScenarios(available, { scenarios: [], exclude: ["long-session"], live: false }),
    ).toEqual({ ok: true, scenarios: [available[0], available[2]] });
  });

  it("applies repeated exclusions to explicitly selected scenarios", () => {
    expect(
      selectScenarios(available, {
        scenarios: ["file-links-on", "long-session", "cold-start"],
        exclude: ["long-session", "long-session"],
        live: false,
      }),
    ).toEqual({ ok: true, scenarios: [available[2], available[0]] });
  });

  it("rejects unknown exclusions", () => {
    expect(
      selectScenarios(available, { scenarios: [], exclude: ["long-sesion"], live: false }),
    ).toEqual({
      ok: false,
      error: "unknown excluded scenario: long-sesion (try --list)",
      exitCode: 2,
    });
  });

  it("rejects an empty selection instead of reporting a successful run", () => {
    expect(
      selectScenarios(available, {
        scenarios: ["long-session"],
        exclude: ["long-session"],
        live: false,
      }),
    ).toEqual({ ok: false, error: "no scenarios remain after exclusions", exitCode: 2 });
  });

  it("still rejects unknown selected scenarios", () => {
    expect(
      selectScenarios(available, { scenarios: ["unknown"], exclude: [], live: false }),
    ).toEqual({ ok: false, error: "unknown scenario: unknown (try --list)", exitCode: 2 });
  });

  it("preserves the live consent requirement for manual scenarios", () => {
    expect(
      selectScenarios(available, {
        scenarios: ["live-playground"],
        exclude: [],
        live: false,
      }),
    ).toEqual({
      ok: false,
      error: "live-playground is manual-only: run it with --cwd <dir> --live",
      exitCode: 1,
    });
    expect(
      selectScenarios(available, { scenarios: ["live-playground"], exclude: [], live: true }),
    ).toEqual({ ok: true, scenarios: [available[3]] });
  });
});
