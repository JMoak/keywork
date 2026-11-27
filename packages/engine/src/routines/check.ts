import { runShellCommand } from "../tools/bash.ts";
import type { RoutineCheck } from "./routine.ts";

export interface CheckRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export interface CheckOutcome {
  exitCode: number | null;
  output: string;
  failure: string | null;
}

export type CheckRunner = (request: CheckRequest) => Promise<CheckOutcome>;

export type CheckVerdict = "quiet" | "woke" | "failed";

export interface CheckResult {
  at: string;
  command: string;
  verdict: CheckVerdict;
  exitCode: number | null;
  ms: number;
  found: string;
  output: string;
}

export const shellCheckRunner: CheckRunner = async ({ command, cwd, timeoutMs }) => {
  try {
    const { exitCode, output } = await runShellCommand(command, cwd, timeoutMs);
    return {
      exitCode,
      output,
      failure: exitCode === null ? "it ended without an exit code" : null,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      exitCode: null,
      output: "",
      failure: message.startsWith("Command timed out")
        ? `it did not finish within ${Math.round(timeoutMs / 1000)} s, so it was stopped`
        : `it could not start: ${firstLineOf(message)}`,
    };
  }
};

export function verdictOf(outcome: CheckOutcome): CheckVerdict {
  if (outcome.failure !== null || outcome.exitCode === null) return "failed";
  return outcome.exitCode === 0 ? "quiet" : "woke";
}

export function checkResultOf(
  check: RoutineCheck,
  outcome: CheckOutcome,
  at: string,
  ms: number,
): CheckResult {
  const verdict = verdictOf(outcome);
  return {
    at,
    command: check.command,
    verdict,
    exitCode: outcome.exitCode,
    ms,
    found: foundOf(verdict, outcome),
    output: tailOf(outcome.output),
  };
}

function foundOf(verdict: CheckVerdict, outcome: CheckOutcome): string {
  switch (verdict) {
    case "quiet":
      return "exited 0: nothing to do, so nothing ran";
    case "woke":
      return `exited ${outcome.exitCode}: something to do, so the chore ran`;
    case "failed":
      return `failed: ${outcome.failure ?? "it ended without an exit code"}`;
  }
}

export const checkOutputKept = 4_000;

function tailOf(output: string): string {
  const trimmed = output.trimEnd();
  return trimmed.length <= checkOutputKept ? trimmed : `…${trimmed.slice(-checkOutputKept)}`;
}

function firstLineOf(text: string): string {
  return text.split("\n")[0]?.trim() ?? text;
}
