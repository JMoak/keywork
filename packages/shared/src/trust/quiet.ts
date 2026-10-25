import type { PermissionRule } from "../config/schema.ts";
import { isDestructiveCommand } from "./destructive-commands.ts";
import { grantCandidates, grantRefusal } from "./grants.ts";
import { commandParts, layeredPolicy } from "./permissions.ts";

export function quietGrant(toolName: string, args: unknown): PermissionRule[] | undefined {
  const rules = grantCandidates(toolName, args);
  if (grantRefusal(toolName, rules) !== undefined) return undefined;
  if (rules.some(isBlanket) || touchesDestructivePart(toolName, args)) return undefined;
  return sessionLayerCovers(rules, toolName, args) ? rules : undefined;
}

const blanketCommand = /^\S+ \*$/;

function isBlanket(rule: PermissionRule): boolean {
  return rule.action === "bash" && blanketCommand.test(rule.resource);
}

function touchesDestructivePart(toolName: string, args: unknown): boolean {
  const command = toolName === "bash" ? commandOf(args) : undefined;
  return command !== undefined && commandParts(command).some(isDestructiveCommand);
}

function sessionLayerCovers(
  rules: readonly PermissionRule[],
  toolName: string,
  args: unknown,
): boolean {
  return layeredPolicy([{ origin: "session", rules }])(toolName, args)?.effect === "allow";
}

function commandOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}
