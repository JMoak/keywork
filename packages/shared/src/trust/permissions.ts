import type { PermissionAction, PermissionsConfig } from "../config/schema.ts";

export type PermissionPolicy = (toolName: string, args: unknown) => PermissionAction | undefined;

export function permissionPolicy(config: PermissionsConfig | undefined): PermissionPolicy {
  const toolRules = new Map(Object.entries(config?.tools ?? {}));
  const bashRules = Object.entries(config?.bash ?? {}).map(compileBashRule);
  return (toolName, args) => {
    if (toolName === "bash") {
      const ruled = bashRuleAction(bashRules, commandFrom(args));
      if (ruled !== undefined) return ruled;
    }
    return toolRules.get(toolName);
  };
}

interface BashRule {
  matches: RegExp;
  action: PermissionAction;
  specificity: number;
}

const commandChainingCharacters = /[;&|<>`$()\n\r]/;

function bashRuleAction(
  rules: BashRule[],
  command: string | undefined,
): PermissionAction | undefined {
  if (command === undefined) return undefined;
  const matching = rules.filter((rule) => rule.matches.test(command));
  if (matching.some((rule) => rule.action === "deny")) return "deny";
  if (commandChainingCharacters.test(command)) return undefined;
  return mostSpecific(matching)?.action;
}

function mostSpecific(rules: BashRule[]): BashRule | undefined {
  return rules.reduce<BashRule | undefined>(
    (winner, rule) =>
      winner === undefined || rule.specificity > winner.specificity ? rule : winner,
    undefined,
  );
}

function compileBashRule([pattern, action]: [string, PermissionAction]): BashRule {
  return { matches: globRegExp(pattern), action, specificity: literalLength(pattern) };
}

function literalLength(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}

function globRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${source}$`);
}

function commandFrom(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}
