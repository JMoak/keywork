import { isAbsolute, relative, resolve } from "node:path";
import type { PermissionEffect, PermissionRule, PermissionsConfig } from "../config/schema.ts";
import { commandGlob, compileGlob, forwardSlashes, type Glob, pathGlob } from "../glob.ts";
import { isDestructiveCommand } from "./destructive-commands.ts";
import { permissionRules } from "./rules.ts";

export type PermissionPolicy = (toolName: string, args: unknown) => PermissionEffect | undefined;

export interface PermissionPolicyOptions {
  readonly workspace?: string;
  readonly caseInsensitivePaths?: boolean;
}

export type RuleOrigin = "trusted" | "workspace" | "session" | "user";

export interface RuleLayer {
  readonly origin: RuleOrigin;
  readonly rules: readonly PermissionRule[];
}

export interface Ruling {
  readonly effect: PermissionEffect;
  readonly origin: RuleOrigin;
}

export type LayeredPolicy = (toolName: string, args: unknown) => Ruling | undefined;

export function permissionPolicy(
  config: PermissionsConfig | undefined,
  options: PermissionPolicyOptions = {},
): PermissionPolicy {
  const policy = layeredPolicy([{ origin: "user", rules: permissionRules(config) }], options);
  return (toolName, args) => policy(toolName, args)?.effect;
}

export function layeredPolicy(
  layers: readonly RuleLayer[],
  options: PermissionPolicyOptions = {},
): LayeredPolicy {
  const rules = layers.flatMap((layer) =>
    layer.rules.map((rule) => compiledRule(rule, layer.origin, options)),
  );
  return (toolName, args) => {
    const governing = rules.filter((rule) => rule.governs(toolName));
    if (governing.length === 0) return undefined;
    const decisive = decisiveRuling(governing, subjectOf(toolName, args, options.workspace));
    return decisive === undefined
      ? undefined
      : { effect: decisive.effect, origin: decisive.origin };
  };
}

export function commandParts(command: string): string[] {
  const parts = command
    .split(commandSeparators)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length === 0 ? [command] : parts;
}

export function isOpaqueCommandPart(part: string): boolean {
  return opaqueShellCharacters.test(part);
}

type ResourceKind = "path" | "command" | "name";

type Subject =
  | { readonly kind: "path"; readonly resources: readonly string[] }
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "name"; readonly resources: readonly string[] };

interface CompiledRule extends Ruling {
  readonly coversEverything: boolean;
  readonly governs: (toolName: string) => boolean;
  readonly matches: (kind: ResourceKind, resource: string) => boolean;
}

const pathTools = new Set(["read", "write", "edit"]);
const grantOrigins: ReadonlySet<RuleOrigin> = new Set(["session", "workspace"]);
const mcpToolSeparator = "__";
const commandSeparators = /[;&|\r\n]+/;
const opaqueShellCharacters = /[<>`$()]/;
const strictnessOrder: readonly (PermissionEffect | undefined)[] = [
  "allow",
  undefined,
  "ask",
  "deny",
];

function compiledRule(
  rule: PermissionRule,
  origin: RuleOrigin,
  options: PermissionPolicyOptions,
): CompiledRule {
  const globs: Readonly<Record<ResourceKind, Glob>> = {
    path: pathGlob(rule.resource, {
      caseInsensitive: options.caseInsensitivePaths ?? process.platform === "win32",
    }),
    command: commandGlob(rule.resource),
    name: compileGlob(rule.resource),
  };
  return {
    effect: rule.effect,
    origin,
    coversEverything: rule.resource === "*",
    governs: (toolName) => actionGoverns(rule.action, toolName),
    matches: (kind, resource) =>
      globs[kind].test(resource) &&
      !(kind === "command" && widensGrantOverDestructive(rule, origin, resource)),
  };
}

function widensGrantOverDestructive(
  rule: PermissionRule,
  origin: RuleOrigin,
  command: string,
): boolean {
  return (
    rule.effect === "allow" &&
    grantOrigins.has(origin) &&
    rule.resource !== command &&
    isDestructiveCommand(command)
  );
}

function actionGoverns(action: string, toolName: string): boolean {
  if (action === "*" || action === toolName) return true;
  return action === "mcp" && toolName.includes(mcpToolSeparator);
}

function subjectOf(
  toolName: string,
  args: unknown,
  workspace: string | undefined,
): Subject | undefined {
  if (toolName === "bash") {
    const command = stringArgument(args, "command");
    return command === undefined ? undefined : { kind: "command", command };
  }
  if (pathTools.has(toolName)) {
    const path = stringArgument(args, "path");
    return path === undefined ? undefined : { kind: "path", resources: pathForms(path, workspace) };
  }
  return { kind: "name", resources: [toolName] };
}

function decisiveRuling(
  rules: readonly CompiledRule[],
  subject: Subject | undefined,
): Ruling | undefined {
  if (subject === undefined) return strictest(rules.filter((rule) => rule.coversEverything));
  return subject.kind === "command"
    ? commandVerdict(rules, subject.command)
    : lastMatch(rules, subject);
}

function commandVerdict(rules: readonly CompiledRule[], command: string): Ruling | undefined {
  const whole = lastMatchingRule(rules, "command", command);
  if (whole?.effect === "deny") return whole;
  return strictest(commandParts(command).map((part) => partVerdict(rules, part)));
}

function partVerdict(rules: readonly CompiledRule[], part: string): Ruling | undefined {
  const rule = lastMatchingRule(rules, "command", part);
  return rule?.effect === "allow" && isOpaqueCommandPart(part) ? undefined : rule;
}

function lastMatch(
  rules: readonly CompiledRule[],
  subject: Extract<Subject, { resources: readonly string[] }>,
): Ruling | undefined {
  return rules.findLast((rule) =>
    subject.resources.some((resource) => rule.matches(subject.kind, resource)),
  );
}

function lastMatchingRule(
  rules: readonly CompiledRule[],
  kind: ResourceKind,
  resource: string,
): CompiledRule | undefined {
  return rules.findLast((rule) => rule.matches(kind, resource));
}

function strictest(rulings: readonly (Ruling | undefined)[]): Ruling | undefined {
  const [first, ...rest] = rulings;
  return rest.reduce(
    (strictestSoFar, ruling) =>
      strictness(ruling) > strictness(strictestSoFar) ? ruling : strictestSoFar,
    first,
  );
}

function strictness(ruling: Ruling | undefined): number {
  return strictnessOrder.indexOf(ruling?.effect);
}

function pathForms(path: string, workspace: string | undefined): string[] {
  if (workspace === undefined) return [forwardSlashes(path).replace(/^(\.\/)+/, "")];
  const absolute = resolve(workspace, path);
  const inside = forwardSlashes(relative(workspace, absolute));
  const outside = inside === ".." || inside.startsWith("../") || isAbsolute(inside);
  const absoluteForm = forwardSlashes(absolute);
  return outside ? [absoluteForm] : [inside, absoluteForm];
}

function stringArgument(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
