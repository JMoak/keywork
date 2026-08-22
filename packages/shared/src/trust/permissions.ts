import type { PermissionAction, PermissionsConfig } from "../config/schema.ts";
import { type GlobRule, globRules, mostSpecificRule } from "../glob.ts";

export type PermissionPolicy = (toolName: string, args: unknown) => PermissionAction | undefined;

export function permissionPolicy(config: PermissionsConfig | undefined): PermissionPolicy {
  const toolRules = new Map(Object.entries(config?.tools ?? {}));
  const bashRules = globRules(config?.bash ?? {});
  return (toolName, args) => {
    if (toolName === "bash") {
      const ruled = bashRuleAction(bashRules, commandFrom(args));
      if (ruled !== undefined) return ruled;
    }
    return toolRules.get(toolName);
  };
}

const commandChainingCharacters = /[;&|<>`$()\n\r]/;

function bashRuleAction(
  rules: readonly GlobRule<PermissionAction>[],
  command: string | undefined,
): PermissionAction | undefined {
  if (command === undefined) return undefined;
  const matching = rules.filter((rule) => rule.glob.test(command));
  if (matching.some((rule) => rule.value === "deny")) return "deny";
  if (commandChainingCharacters.test(command)) return undefined;
  return mostSpecificRule(matching)?.value;
}

function commandFrom(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}
