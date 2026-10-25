import type { PermissionRule } from "../config/schema.ts";
import { commandWords, gitInvocation } from "./command-words.ts";
import { type DestructiveRemembrance, destructiveRemembrance } from "./destructive-commands.ts";
import { commandParts, isOpaqueCommandPart, layeredPolicy } from "./permissions.ts";

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

export type GrantAheadRefusal =
  | { kind: "write-once" }
  | { kind: "tool-pattern" }
  | { kind: "server-pattern" }
  | { kind: "destructive"; command: string; remembered: DestructiveRemembrance }
  | { kind: "underivable"; derived: readonly PermissionRule[] };

export function grantAheadRefusal(rule: PermissionRule): GrantAheadRefusal | undefined {
  if (onceOnlyTools.has(rule.action)) return { kind: "write-once" };
  if (rule.action.includes("*")) return { kind: "tool-pattern" };
  if (rule.action === "bash") return commandGrantRefusal(rule);
  if (rule.action === mcpServersAction) return serverGrantRefusal(rule);
  return refusedUnlessDerived(rule, grantCandidates(rule.action, undefined));
}

export class SessionGrants {
  private held: readonly PermissionRule[] = [];

  get rules(): readonly PermissionRule[] {
    return this.held;
  }

  covers(toolName: string, args: unknown): boolean {
    if (this.held.length === 0) return false;
    const ruling = layeredPolicy([{ origin: "session", rules: this.held }])(toolName, args);
    return ruling?.effect === "allow";
  }

  remember(toolName: string, args: unknown): readonly PermissionRule[] {
    const candidates = grantCandidates(toolName, args);
    return grantRefusal(toolName, candidates) === undefined ? this.grant(candidates) : [];
  }

  grant(rules: readonly PermissionRule[]): readonly PermissionRule[] {
    const held = withRules(this.held, rules);
    const joined = held.slice(this.held.length);
    this.held = held;
    return joined;
  }

  forget(rule: PermissionRule): boolean {
    const kept = this.held.filter((held) => !sameRule(held, rule));
    const dropped = kept.length !== this.held.length;
    this.held = kept;
    return dropped;
  }

  adopt(rules: readonly PermissionRule[]): void {
    this.held = withRules([], rules);
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
const mcpServersAction = "mcp";
const wholeServerSuffix = `${mcpToolSeparator}*`;
const serverName = /^[\w-]+$/;
const onceOnlyTools = new Set(["write", "edit"]);
const literalWord = /^-{0,2}[A-Za-z][\w-]*$/;

type Remembrance = DestructiveRemembrance | "leading-words";

const rememberedResources: Readonly<Record<Remembrance, (part: string) => string[]>> = {
  "leading-words": leadingWordsGlob,
  "exact-command": exactCommand,
  nothing: () => [],
};

function commandGrants(command: string | undefined): PermissionRule[] {
  if (command === undefined) return [];
  const resources = commandParts(command)
    .filter((part) => !isOpaqueCommandPart(part))
    .flatMap((part) => rememberedResources[remembranceOf(part)](part));
  return withRules(
    [],
    resources.map((resource) => allow("bash", resource)),
  );
}

function remembranceOf(part: string): Remembrance {
  return destructiveRemembrance(part) ?? "leading-words";
}

function leadingWordsGlob(part: string): string[] {
  const head = commandHead(commandWords(part));
  if (head.length === 0 || head.some((word) => word.includes("*"))) return [];
  return [`${head.join(" ")} *`];
}

function commandHead(words: readonly string[]): readonly string[] {
  const git = gitInvocation(words);
  if (git !== undefined) return git.head;
  const [program, second] = words;
  if (program === undefined) return [];
  return second !== undefined && literalWord.test(second) ? [program, second] : [program];
}

function exactCommand(part: string): string[] {
  return part.includes("*") ? [] : [part];
}

const wildcardTail = " *";

function commandGrantRefusal(rule: PermissionRule): GrantAheadRefusal | undefined {
  const command = rule.resource.endsWith(wildcardTail)
    ? rule.resource.slice(0, -wildcardTail.length)
    : rule.resource;
  const remembered = destructiveRemembrance(command);
  if (remembered === "nothing" || (remembered === "exact-command" && rule.resource.includes("*"))) {
    return { kind: "destructive", command, remembered };
  }
  return refusedUnlessDerived(rule, grantCandidates("bash", { command }));
}

function serverGrantRefusal(rule: PermissionRule): GrantAheadRefusal | undefined {
  if (namesWholeServer(rule.resource)) return undefined;
  if (rule.resource.includes("*")) return { kind: "server-pattern" };
  return refusedUnlessDerived(rule, grantCandidates(rule.resource, undefined));
}

function namesWholeServer(resource: string): boolean {
  if (!resource.endsWith(wholeServerSuffix)) return false;
  const server = resource.slice(0, -wholeServerSuffix.length);
  return serverName.test(server) && !server.includes(mcpToolSeparator);
}

function refusedUnlessDerived(
  rule: PermissionRule,
  derived: readonly PermissionRule[],
): GrantAheadRefusal | undefined {
  const [only, ...others] = derived;
  const derivable = only !== undefined && others.length === 0 && sameRule(only, rule);
  return derivable ? undefined : { kind: "underivable", derived };
}

function allow(action: string, resource: string): PermissionRule {
  return { action, resource, effect: "allow" };
}

function commandOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}
