import type { CaptureArgs } from "./cli-args.ts";
import type { Scenario } from "./scenario.ts";

export type ScenarioSelection =
  | { readonly ok: true; readonly scenarios: readonly Scenario[] }
  | { readonly ok: false; readonly error: string; readonly exitCode: 1 | 2 };

export function selectScenarios(
  available: readonly Scenario[],
  args: Pick<CaptureArgs, "scenarios" | "exclude" | "live">,
): ScenarioSelection {
  const excluded = new Set(args.exclude);
  for (const name of excluded) {
    if (!available.some((scenario) => scenario.name === name)) {
      return { ok: false, error: `unknown excluded scenario: ${name} (try --list)`, exitCode: 2 };
    }
  }
  const chosen: Scenario[] = [];
  for (const name of args.scenarios) {
    const scenario = available.find((candidate) => candidate.name === name);
    if (scenario === undefined) {
      return { ok: false, error: `unknown scenario: ${name} (try --list)`, exitCode: 2 };
    }
    if (scenario.manual === true && !args.live) {
      return {
        ok: false,
        error: `${name} is manual-only: run it with --cwd <dir> --live`,
        exitCode: 1,
      };
    }
    chosen.push(scenario);
  }
  const selected = (
    args.scenarios.length === 0 ? available.filter((scenario) => scenario.manual !== true) : chosen
  ).filter((scenario) => !excluded.has(scenario.name));
  if (selected.length === 0) {
    return { ok: false, error: "no scenarios remain after exclusions", exitCode: 2 };
  }
  return { ok: true, scenarios: selected };
}
