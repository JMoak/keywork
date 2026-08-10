import type { PermissionAction, PermissionsConfig } from "../config/schema.ts";

export type PermissionPolicy = (toolName: string, args: unknown) => PermissionAction | undefined;

export function permissionPolicy(config: PermissionsConfig | undefined): PermissionPolicy {
  const bashRules = Object.entries(config?.bash ?? {});
  return (toolName, args) => {
    if (toolName === "bash") {
      const ruled = bashRuleAction(bashRules, commandFrom(args));
      if (ruled !== undefined) return ruled;
    }
    return config?.tools?.[toolName];
  };
}

const commandChainingCharacters = /[;&|<>`$()\n\r]/;

function bashRuleAction(
  rules: [string, PermissionAction][],
  command: string | undefined,
): PermissionAction | undefined {
  if (command === undefined) return undefined;
  const matching = rules.filter(([pattern]) => globMatches(pattern, command));
  if (commandChainingCharacters.test(command)) {
    return matching.some(([, action]) => action === "deny") ? "deny" : undefined;
  }
  return mostSpecific(matching)?.[1];
}

function mostSpecific(rules: [string, PermissionAction][]): [string, PermissionAction] | undefined {
  return rules.reduce<[string, PermissionAction] | undefined>(
    (winner, rule) =>
      winner === undefined || literalLength(rule[0]) > literalLength(winner[0]) ? rule : winner,
    undefined,
  );
}

function literalLength(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}

function globMatches(pattern: string, text: string): boolean {
  const source = pattern
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${source}$`).test(text);
}

function commandFrom(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}
