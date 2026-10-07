import { isAbsolute, relative, resolve } from "node:path";
import type { PermissionEffect, PermissionRule, PermissionsConfig } from "../config/schema.ts";
import { commandGlob, compileGlob, forwardSlashes, type Glob, pathGlob } from "../glob.ts";
import { permissionRules } from "./rules.ts";

export type PermissionPolicy = (toolName: string, args: unknown) => PermissionEffect | undefined;

export interface PermissionPolicyOptions {
  readonly workspace?: string;
  readonly caseInsensitivePaths?: boolean;
}

export function permissionPolicy(
  config: PermissionsConfig | undefined,
  options: PermissionPolicyOptions = {},
): PermissionPolicy {
  const rules = permissionRules(config).map((rule) => compiledRule(rule, options));
  return (toolName, args) => {
    const governing = rules.filter((rule) => rule.governs(toolName));
    if (governing.length === 0) return undefined;
    const subject = subjectOf(toolName, args, options.workspace);
    if (subject === undefined) return strictest(wildcardEffects(governing));
    return subject.kind === "command"
      ? commandVerdict(governing, subject.command)
      : lastMatch(governing, subject);
  };
}

type ResourceKind = "path" | "command" | "name";

type Subject =
  | { readonly kind: "path"; readonly resources: readonly string[] }
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "name"; readonly resources: readonly string[] };

interface CompiledRule {
  readonly effect: PermissionEffect;
  readonly coversEverything: boolean;
  readonly governs: (toolName: string) => boolean;
  readonly matches: (kind: ResourceKind, resource: string) => boolean;
}

const pathTools = new Set(["read", "write", "edit"]);
const mcpToolSeparator = "__";
const commandSeparators = /[;&|\r\n]+/;
const opaqueShellCharacters = /[<>`$()]/;
const strictnessOrder: readonly (PermissionEffect | undefined)[] = [
  "allow",
  undefined,
  "ask",
  "deny",
];

function compiledRule(rule: PermissionRule, options: PermissionPolicyOptions): CompiledRule {
  const globs: Readonly<Record<ResourceKind, Glob>> = {
    path: pathGlob(rule.resource, {
      caseInsensitive: options.caseInsensitivePaths ?? process.platform === "win32",
    }),
    command: commandGlob(rule.resource),
    name: compileGlob(rule.resource),
  };
  return {
    effect: rule.effect,
    coversEverything: rule.resource === "*",
    governs: (toolName) => actionGoverns(rule.action, toolName),
    matches: (kind, resource) => globs[kind].test(resource),
  };
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

function commandVerdict(
  rules: readonly CompiledRule[],
  command: string,
): PermissionEffect | undefined {
  if (lastMatchingEffect(rules, "command", command) === "deny") return "deny";
  return strictest(commandParts(command).map((part) => partVerdict(rules, part)));
}

function partVerdict(rules: readonly CompiledRule[], part: string): PermissionEffect | undefined {
  const effect = lastMatchingEffect(rules, "command", part);
  return effect === "allow" && opaqueShellCharacters.test(part) ? undefined : effect;
}

function commandParts(command: string): string[] {
  const parts = command
    .split(commandSeparators)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length === 0 ? [command] : parts;
}

function lastMatch(
  rules: readonly CompiledRule[],
  subject: Extract<Subject, { resources: readonly string[] }>,
): PermissionEffect | undefined {
  return rules.findLast((rule) =>
    subject.resources.some((resource) => rule.matches(subject.kind, resource)),
  )?.effect;
}

function lastMatchingEffect(
  rules: readonly CompiledRule[],
  kind: ResourceKind,
  resource: string,
): PermissionEffect | undefined {
  return rules.findLast((rule) => rule.matches(kind, resource))?.effect;
}

function wildcardEffects(rules: readonly CompiledRule[]): PermissionEffect[] {
  return rules.filter((rule) => rule.coversEverything).map((rule) => rule.effect);
}

function strictest(
  effects: readonly (PermissionEffect | undefined)[],
): PermissionEffect | undefined {
  const [first, ...rest] = effects;
  return rest.reduce(
    (strictestSoFar, effect) =>
      strictnessOrder.indexOf(effect) > strictnessOrder.indexOf(strictestSoFar)
        ? effect
        : strictestSoFar,
    first,
  );
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
