import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type AskedChange,
  type AskRule,
  childDirFor,
  type DenyReason,
  type JournaledAsk,
  journalEvents,
  type NamedSecret,
  type PermissionDecision,
  type PermissionGate,
  redactForPersistence,
  redactSecrets,
  type SessionEntry,
  type SessionStore,
  type ToolCallPart,
} from "@keywork/engine";
import {
  type AskScope,
  commandParts,
  isDestructiveCommand,
  isOpaqueCommandPart,
} from "@keywork/shared";
import { scanSessions, type UnreadableSession } from "./store.ts";

export const toolDecisionSchema = "keywork.tool-decision/1";

export const decisionExportCaps = { command: 2_000, arguments: 1_000 } as const;

export interface ToolDecisionRecord {
  schema: typeof toolDecisionSchema;
  session: string;
  rootSession: string;
  callId: string;
  at: string;
  tool: string;
  subject: DecisionSubject;
  ask?: AskFacts;
  answer: AnswerFacts;
  result?: { isError: boolean };
}

export type DecisionSubject = CommandSubject | PathSubject | CallSubject;

export interface CommandSubject {
  kind: "command";
  command: string;
  truncated: boolean;
  parts: number;
  destructive: boolean;
  opaque: boolean;
}

export interface PathSubject {
  kind: "path";
  path: string;
  insideWorkspace: boolean;
  change?: PathChange;
}

export type PathChange =
  | { kind: "write"; lines: number }
  | { kind: "edit"; removedLines: number; addedLines: number; replaceAll: boolean };

export interface CallSubject {
  kind: "call";
  arguments: string;
  truncated: boolean;
}

export interface AskFacts {
  at: string;
  rule: AskRule;
  grantable: boolean;
  change?: AskedChange;
}

export type AnsweredBy = "person" | "headless" | "grant" | "rule" | "unknown";

export interface AnswerFacts {
  at: string;
  verdict: PermissionDecision["verdict"];
  gate: PermissionGate;
  scope?: AskScope;
  by: AnsweredBy;
  afterMs?: number;
  reason?: DenyReason;
}

export interface DecisionExportOptions {
  secrets: readonly NamedSecret[];
  home?: string;
}

export interface DecisionExport {
  records: ToolDecisionRecord[];
  sessions: number;
  unreadable: UnreadableSession[];
}

export async function exportToolDecisions(
  dir: string,
  options: DecisionExportOptions,
): Promise<DecisionExport> {
  const roots = await scanSessions(dir);
  const exported: DecisionExport = { records: [], sessions: 0, unreadable: [...roots.unreadable] };
  for (const root of roots.stores) {
    const family = await sessionFamily(root);
    exported.unreadable.push(...family.unreadable);
    exported.sessions += family.stores.length;
    for (const store of family.stores) {
      exported.records.push(...toolDecisionsOf(store, { ...options, rootSession: root.header.id }));
    }
  }
  return exported;
}

export function toolDecisionsOf(
  store: SessionStore,
  options: DecisionExportOptions & { rootSession: string },
): ToolDecisionRecord[] {
  const journal = journalOf(store.entries());
  const scrub = scrubberOf(options.secrets);
  const place: Place = { cwd: store.header.cwd, home: options.home ?? homedir() };
  return journal.decisions.flatMap(({ decision, at }) => {
    const call = journal.calls.get(decision.callId);
    if (call === undefined) return [];
    const ask = journal.asks.get(decision.callId);
    const isError = journal.results.get(decision.callId);
    const record: ToolDecisionRecord = {
      schema: toolDecisionSchema,
      session: store.header.id,
      rootSession: options.rootSession,
      callId: decision.callId,
      at,
      tool: call.name,
      subject: subjectOf(call, place, scrub),
      ...(ask !== undefined && { ask: askFactsOf(ask) }),
      answer: answerFactsOf(decision, at, ask),
      ...(decision.verdict === "granted" && isError !== undefined && { result: { isError } }),
    };
    return [record];
  });
}

export function toolDecisionLines(records: readonly ToolDecisionRecord[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

export async function writeToolDecisions(
  path: string,
  records: readonly ToolDecisionRecord[],
): Promise<void> {
  await writeFile(path, toolDecisionLines(records), "utf8");
}

interface Place {
  cwd: string;
  home: string;
}

interface TimedAsk {
  ask: JournaledAsk;
  at: string;
}

interface TimedDecision {
  decision: PermissionDecision;
  at: string;
}

interface SessionJournal {
  calls: Map<string, ToolCallPart>;
  results: Map<string, boolean>;
  asks: Map<string, TimedAsk>;
  decisions: TimedDecision[];
}

type Scrubber = (text: string, cap?: number) => { text: string; truncated: boolean };

const pathTools = new Set(["read", "write", "edit"]);

const secretName =
  "[A-Za-z_][A-Za-z0-9_]*(?:key|token|secret|passw(?:or)?d|credential)[A-Za-z0-9_]*";
const assignedSecret = new RegExp(
  String.raw`\b(${secretName})(\s*=\s*)("[^"]*"|'[^']*'|[^\s;&|]+)`,
  "gi",
);

async function sessionFamily(
  store: SessionStore,
): Promise<{ stores: SessionStore[]; unreadable: UnreadableSession[] }> {
  const children = await scanSessions(childDirFor(store.file));
  const nested = await Promise.all(children.stores.map(sessionFamily));
  return {
    stores: [store, ...nested.flatMap((family) => family.stores)],
    unreadable: [...children.unreadable, ...nested.flatMap((family) => family.unreadable)],
  };
}

function journalOf(entries: readonly SessionEntry[]): SessionJournal {
  const journal: SessionJournal = {
    calls: new Map(),
    results: new Map(),
    asks: new Map(),
    decisions: [],
  };
  for (const entry of entries) noteEntry(journal, entry);
  return journal;
}

function noteEntry(journal: SessionJournal, entry: SessionEntry): void {
  if (entry.type === "message") {
    for (const part of entry.message.parts) {
      if (part.type === "tool-call") journal.calls.set(part.callId, part);
      if (part.type === "tool-result") journal.results.set(part.callId, part.isError);
    }
    return;
  }
  const [event] = journalEvents([entry]);
  if (event?.type === "permission_ask" && hasCallId(event.ask)) {
    journal.asks.set(event.ask.callId, { ask: event.ask, at: entry.timestamp });
  }
  if (event?.type === "permission_decision" && hasCallId(event.decision)) {
    journal.decisions.push({ decision: event.decision, at: entry.timestamp });
  }
}

function hasCallId(value: unknown): boolean {
  return typeof (value as { callId?: unknown } | undefined)?.callId === "string";
}

function subjectOf(call: ToolCallPart, place: Place, scrub: Scrubber): DecisionSubject {
  const args = recordOf(call.arguments);
  if (call.name === "bash" && typeof args.command === "string") {
    return commandSubject(args.command, scrub);
  }
  if (pathTools.has(call.name) && typeof args.path === "string") {
    return pathSubject(call.name, args.path, args, place);
  }
  return callSubject(call.arguments, scrub);
}

function commandSubject(command: string, scrub: Scrubber): CommandSubject {
  const parts = commandParts(command);
  const scrubbed = scrub(command, decisionExportCaps.command);
  return {
    kind: "command",
    command: scrubbed.text,
    truncated: scrubbed.truncated,
    parts: parts.length,
    destructive: parts.some(isDestructiveCommand),
    opaque: parts.some(isOpaqueCommandPart),
  };
}

function pathSubject(
  tool: string,
  path: string,
  args: Record<string, unknown>,
  place: Place,
): PathSubject {
  const located = locate(path, place);
  const change = pathChangeOf(tool, args);
  return {
    kind: "path",
    path: located.path,
    insideWorkspace: located.inside,
    ...(change !== undefined && { change }),
  };
}

function callSubject(args: unknown, scrub: Scrubber): CallSubject {
  const scrubbed = scrub(JSON.stringify(redactSecrets(args) ?? null), decisionExportCaps.arguments);
  return { kind: "call", arguments: scrubbed.text, truncated: scrubbed.truncated };
}

function pathChangeOf(tool: string, args: Record<string, unknown>): PathChange | undefined {
  if (tool === "write" && typeof args.content === "string") {
    return { kind: "write", lines: lineCount(args.content) };
  }
  if (tool === "edit" && typeof args.oldText === "string" && typeof args.newText === "string") {
    return {
      kind: "edit",
      removedLines: lineCount(args.oldText),
      addedLines: lineCount(args.newText),
      replaceAll: args.replaceAll === true,
    };
  }
  return undefined;
}

function locate(path: string, place: Place): { path: string; inside: boolean } {
  const absolute = resolve(place.cwd, path);
  const fromCwd = relative(place.cwd, absolute);
  if (isWithin(fromCwd))
    return { path: forwardSlashes(fromCwd === "" ? "." : fromCwd), inside: true };
  const fromHome = relative(place.home, absolute);
  const shown = isWithin(fromHome) ? `~${sep}${fromHome}` : absolute;
  return { path: forwardSlashes(shown), inside: false };
}

function isWithin(relativePath: string): boolean {
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function forwardSlashes(path: string): string {
  return path.split(sep).join("/");
}

function askFactsOf({ ask, at }: TimedAsk): AskFacts {
  return {
    at,
    rule: ask.rule,
    grantable: Array.isArray(ask.rules) && ask.rules.length > 0,
    ...(ask.change !== undefined && { change: ask.change }),
  };
}

function answerFactsOf(
  decision: PermissionDecision,
  at: string,
  ask: TimedAsk | undefined,
): AnswerFacts {
  const afterMs = ask === undefined ? Number.NaN : Date.parse(at) - Date.parse(ask.at);
  return {
    at,
    verdict: decision.verdict,
    gate: decision.gate,
    ...(decision.scope !== undefined && { scope: decision.scope }),
    by: answeredBy(decision, ask !== undefined),
    ...(Number.isFinite(afterMs) && afterMs >= 0 && { afterMs }),
    ...(decision.reason !== undefined && { reason: decision.reason }),
  };
}

function answeredBy(decision: PermissionDecision, askJournaled: boolean): AnsweredBy {
  if (decision.asked === true || askJournaled) {
    return decision.gate === "headless" ? "headless" : "person";
  }
  if (decision.asked === false) return decision.gate === "user" ? "grant" : "rule";
  return answeredBeforeAskedWasRecorded(decision);
}

function answeredBeforeAskedWasRecorded(decision: PermissionDecision): AnsweredBy {
  if (decision.gate === "headless") return "headless";
  if (decision.gate !== "user") return "rule";
  const answeredNow =
    decision.verdict === "denied" || decision.scope === undefined || decision.scope === "once";
  return answeredNow ? "person" : "unknown";
}

function scrubberOf(secrets: readonly NamedSecret[]): Scrubber {
  return (text, cap) => {
    const redacted = redactForPersistence(text, secrets).replace(
      assignedSecret,
      (_match, name: string, equals: string) => `${name}${equals}‹redacted:assignment›`,
    );
    if (cap === undefined || redacted.length <= cap) return { text: redacted, truncated: false };
    return { text: redacted.slice(0, cap), truncated: true };
  };
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
