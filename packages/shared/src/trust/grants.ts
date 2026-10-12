import type { PermissionRule } from "../config/schema.ts";
import { commandParts, isOpaqueCommandPart, permissionPolicy } from "./permissions.ts";

export type AskScope = "once" | "session" | "workspace";

export type GrantRefusal = "write-once" | "nothing-to-remember";

export function grantCandidates(toolName: string, args: unknown): PermissionRule[] {
  if (toolName === "bash") return commandGrants(commandOf(args));
  if (toolName.includes(mcpToolSeparator)) return [allow(toolName, "*")];
  return [];
}

export function grantRefusal(
  toolName: string,
  candidates: readonly PermissionRule[],
): GrantRefusal | undefined {
  if (onceOnlyTools.has(toolName)) return "write-once";
  return candidates.length === 0 ? "nothing-to-remember" : undefined;
}

export class SessionGrants {
  private held: PermissionRule[] = [];

  get rules(): readonly PermissionRule[] {
    return this.held;
  }

  covers(toolName: string, args: unknown): boolean {
    return this.held.length > 0 && permissionPolicy(this.held)(toolName, args) === "allow";
  }

  remember(toolName: string, args: unknown): readonly PermissionRule[] {
    const candidates = grantCandidates(toolName, args);
    if (grantRefusal(toolName, candidates) !== undefined) return [];
    this.held = withRules(this.held, candidates);
    return candidates;
  }

  forget(rule: PermissionRule): boolean {
    const kept = this.held.filter((held) => !sameRule(held, rule));
    const dropped = kept.length !== this.held.length;
    this.held = kept;
    return dropped;
  }
}

export function ruleLabel(rule: PermissionRule): string {
  return `${rule.action} ${rule.resource}`;
}

export function grantFromLabel(label: string): PermissionRule | undefined {
  const [action, ...resource] = label.trim().split(/\s+/);
  if (action === undefined || action === "" || resource.length === 0) return undefined;
  return allow(action, resource.join(" "));
}

export function sameRule(left: PermissionRule, right: PermissionRule): boolean {
  return (
    left.action === right.action && left.resource === right.resource && left.effect === right.effect
  );
}

export function withRules(
  existing: readonly PermissionRule[],
  added: readonly PermissionRule[],
): PermissionRule[] {
  const rules = [...existing];
  for (const rule of added) {
    if (!rules.some((held) => sameRule(held, rule))) rules.push(rule);
  }
  return rules;
}

const mcpToolSeparator = "__";
const onceOnlyTools = new Set(["write", "edit"]);
const literalWord = /^-{0,2}[A-Za-z][\w-]*$/;

function commandGrants(command: string | undefined): PermissionRule[] {
  if (command === undefined) return [];
  const resources = commandParts(command)
    .filter((part) => !isOpaqueCommandPart(part))
    .flatMap(leadingWordsGlob);
  return withRules(
    [],
    resources.map((resource) => allow("bash", resource)),
  );
}

function leadingWordsGlob(part: string): string[] {
  const [program = part, second] = part.split(/\s+/);
  if (program.includes("*")) return [];
  const subcommand = second !== undefined && literalWord.test(second) ? ` ${second}` : "";
  return [`${program}${subcommand} *`];
}

function allow(action: string, resource: string): PermissionRule {
  return { action, resource, effect: "allow" };
}

function commandOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}
