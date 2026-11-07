import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  commandParts,
  isDestructiveCommand,
  isOpaqueCommandPart,
  ruleLabel,
} from "@keywork/shared";
import { redactSecrets } from "../../diagnostics.ts";
import { type NamedSecret, redactForPersistence } from "../../memory/redaction.ts";
import type { AskRule, PermissionAsk } from "../../session/journal.ts";

export const oneWayDoorClass = "one-way door";
export const askTextLimit = 2_000;

export type WorkspacePosition = boolean | "unknown";

export interface AskFacts {
  tool: string;
  askedBecause: AskRule;
  rules: string[];
  ruleClass: string;
  destructive: boolean;
  opaque: boolean;
  commandParts?: number;
  insideWorkspace?: WorkspacePosition;
  askText: string;
  truncated: boolean;
}

export interface AskFactsOptions {
  cwd?: string | undefined;
  secrets?: readonly NamedSecret[] | undefined;
}

export function askFactsOf(ask: PermissionAsk, options: AskFactsOptions = {}): AskFacts {
  const subject = subjectOf(ask, options.cwd);
  const rules = ask.rules.map(ruleLabel);
  const askText = redactForPersistence(subject.text, options.secrets ?? []);
  return {
    tool: ask.tool,
    askedBecause: ask.rule,
    rules,
    ruleClass: ruleClassOf(ask.tool, rules, subject),
    destructive: subject.kind === "command" && subject.destructive,
    opaque: subject.kind === "command" && subject.opaque,
    ...(subject.kind === "command" && { commandParts: subject.parts }),
    ...(subject.kind === "path" && { insideWorkspace: subject.inside }),
    askText,
    truncated: askText.length > askTextLimit,
  };
}

export function isOneWayDoorClass(ruleClass: string): boolean {
  return ruleClass === oneWayDoorClass || ruleClass.split(" + ").some(namesDestructiveCommand);
}

type Subject =
  | { kind: "command"; text: string; parts: number; destructive: boolean; opaque: boolean }
  | { kind: "path"; text: string; inside: WorkspacePosition }
  | { kind: "call"; text: string };

const pathTools: ReadonlySet<string> = new Set(["read", "write", "edit"]);

function subjectOf(ask: PermissionAsk, cwd: string | undefined): Subject {
  const args = recordOf(ask.arguments);
  if (ask.tool === "bash" && typeof args.command === "string") return commandSubject(args.command);
  if (pathTools.has(ask.tool) && typeof args.path === "string") {
    return { kind: "path", text: args.path, inside: positionOf(args.path, ask, cwd) };
  }
  return { kind: "call", text: JSON.stringify(redactSecrets(ask.arguments) ?? null) };
}

function commandSubject(command: string): Subject {
  const parts = commandParts(command);
  return {
    kind: "command",
    text: command,
    parts: parts.length,
    destructive: parts.some(isDestructiveCommand),
    opaque: parts.some(isOpaqueCommandPart),
  };
}

function positionOf(path: string, ask: PermissionAsk, cwd: string | undefined): WorkspacePosition {
  if (cwd !== undefined) return isWithin(relative(cwd, resolve(cwd, path)));
  const shown = ask.preview?.path;
  if (shown === undefined) return "unknown";
  return !isAbsolute(shown) && shown !== ".." && !shown.startsWith("../");
}

function isWithin(relativePath: string): boolean {
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function ruleClassOf(tool: string, rules: readonly string[], subject: Subject): string {
  if (subject.kind === "command" && subject.destructive) return oneWayDoorClass;
  if (rules.length > 0) return [...new Set(rules)].sort().join(" + ");
  if (subject.kind === "command" && subject.opaque) return `${tool} (opaque)`;
  return tool;
}

function namesDestructiveCommand(rule: string): boolean {
  const command = /^bash (.+?)(?: \*)?$/.exec(rule.trim())?.[1];
  return command !== undefined && commandParts(command).some(isDestructiveCommand);
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
