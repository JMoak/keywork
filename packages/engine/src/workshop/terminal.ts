import type { PermissionRule } from "@keywork/shared";
import { z } from "zod";
import type { Command, Exit, Workshop } from "./substrate.ts";
import type { Refused } from "./workshops.ts";

export const terminalGrantAction = "workshop.exec";

export const terminalInputSchema = z.strictObject({
  command: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .describe("One command line, run by the workshop's own shell from its workdir."),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("A directory inside the workshop's workdir to run from; the workdir when omitted."),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .optional()
    .describe("Kill the command after this long; two minutes when omitted."),
});

export type TerminalInput = z.infer<typeof terminalInputSchema>;

export interface TerminalAccess {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface TerminalRun extends Exit {
  readonly workshop: string;
}

export type TerminalOutcome =
  | { readonly code: number; readonly timedOut: boolean }
  | { readonly refused: Refused["refused"]; readonly error: string };

export interface TerminalEntry {
  readonly at: string;
  readonly tool: "bash";
  readonly origin: "keeper";
  readonly input: TerminalInput;
  readonly outcome: TerminalOutcome;
}

export function terminalAccess(
  workshop: Workshop,
  grants: readonly PermissionRule[],
): TerminalAccess {
  const rule = grants.filter((candidate) => coversTerminal(candidate, workshop)).at(-1);
  if (rule === undefined) return defaultAccess(workshop);
  const named = `the keeper's rule ${terminalGrantAction} ${rule.resource}`;
  if (rule.effect === "allow") return { allowed: true, reason: `${named} allows it` };
  return {
    allowed: false,
    reason: `${named} says ${rule.effect}; a typed terminal cannot ask, so it refuses`,
  };
}

export function terminalCommandOf(input: TerminalInput): Command {
  return {
    run: input.command,
    ...(input.cwd !== undefined && { cwd: input.cwd }),
    ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
  };
}

export function terminalOutcomeOf(outcome: Exit | Refused): TerminalOutcome {
  if ("refused" in outcome) return { refused: outcome.refused, error: outcome.error };
  return { code: outcome.code, timedOut: outcome.timedOut };
}

function coversTerminal(rule: PermissionRule, workshop: Workshop): boolean {
  if (rule.action !== terminalGrantAction) return false;
  return (
    rule.resource === "*" || rule.resource === workshop.id || rule.resource === workshop.creature
  );
}

function defaultAccess(workshop: Workshop): TerminalAccess {
  if (workshop.substrate !== "host") {
    return {
      allowed: true,
      reason: `the ${workshop.substrate} workshop is its own machine, so typed commands stay inside it`,
    };
  }
  return {
    allowed: false,
    reason: `${workshop.id} is a bare host workshop, so a typed command would run on this node itself; it stays closed until the keeper grants { action: "${terminalGrantAction}", resource: "${workshop.id}", effect: "allow" }`,
  };
}
