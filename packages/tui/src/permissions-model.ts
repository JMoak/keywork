import type {
  EngineEvents,
  PermissionDecision,
  PermissionsView,
  ToolCallPart,
} from "@keywork/engine";
import { type PermissionRule, ruleLabel } from "@keywork/shared";
import type { ConnectRow, ConnectSpan, ConnectTone } from "./connect-model.ts";
import type { Chord } from "./keys.ts";
import { compactJson } from "./transcript-feed.ts";

export interface PermissionsPort {
  view(): PermissionsView;
  revokeWorkspace(rule: PermissionRule): boolean;
  recordedAt?(): Date | undefined;
}

export interface SessionGrantsPort {
  rules(): readonly PermissionRule[];
  forget(rule: PermissionRule): boolean;
}

export interface FocusedPermissionsPort {
  session(): SessionGrantsPort | undefined;
  lastQuietRun(): QuietRun | undefined;
}

export type QuietReason = "trusted" | "session" | "workspace";

export interface QuietRun {
  summary: string;
  reason: QuietReason;
}

export interface PermissionsHooks {
  notify(): void;
  notice(text: string): void;
  focused?: FocusedPermissionsPort | undefined;
}

export interface GrantEntry {
  layer: "workspace" | "session";
  rule: PermissionRule;
}

export type PermissionsKeyOutcome = "stay" | "close";

export const permissionsKeyHint = "↑↓ pick · r revokes · d drops · b shows the bundle · esc closes";

interface QuietBus {
  on<K extends "tool.started" | "gate.permission">(
    type: K,
    listener: (payload: EngineEvents[K]) => void,
  ): () => void;
}

export class QuietRunLog {
  private readonly calls = new Map<string, ToolCallPart>();
  private readonly decisions = new Map<string, PermissionDecision>();
  private last: QuietRun | undefined;

  get lastQuietRun(): QuietRun | undefined {
    return this.last;
  }

  follow(bus: QuietBus): () => void {
    const stops = [
      bus.on("tool.started", ({ call }) => this.noteCall(call)),
      bus.on("gate.permission", ({ decision }) => this.noteDecision(decision)),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  private noteCall(call: ToolCallPart): void {
    const decision = this.decisions.get(call.callId);
    if (decision === undefined) {
      this.calls.set(call.callId, call);
      return;
    }
    this.decisions.delete(call.callId);
    this.settle(call, decision);
  }

  private noteDecision(decision: PermissionDecision): void {
    const call = this.calls.get(decision.callId);
    if (call === undefined) {
      this.decisions.set(decision.callId, decision);
      return;
    }
    this.calls.delete(decision.callId);
    this.settle(call, decision);
  }

  private settle(call: ToolCallPart, decision: PermissionDecision): void {
    const reason = quietReasonOf(decision);
    if (reason !== undefined) this.last = { summary: callSummary(call), reason };
  }
}

export function quietReasonOf(decision: PermissionDecision): QuietReason | undefined {
  if (decision.verdict !== "granted") return undefined;
  if (decision.gate === "trusted") return "trusted";
  if (decision.gate === "user" && decision.scope !== undefined && decision.scope !== "once") {
    return decision.scope;
  }
  return undefined;
}

export class PermissionsModel {
  index = 0;
  bundleShown = false;

  constructor(
    private readonly port: PermissionsPort,
    private readonly hooks: PermissionsHooks,
  ) {}

  entries(): GrantEntry[] {
    const session = this.hooks.focused?.session();
    return [
      ...this.port.view().workspace.map((rule) => ({ layer: "workspace" as const, rule })),
      ...(session?.rules() ?? []).map((rule) => ({ layer: "session" as const, rule })),
    ];
  }

  selected(): GrantEntry | undefined {
    return this.entries()[this.index];
  }

  rowCount(): number {
    return this.allRows().length;
  }

  rows(limit = Number.POSITIVE_INFINITY): ConnectRow[] {
    const rows = this.allRows();
    if (rows.length <= limit) return rows;
    const selectedRow = Math.max(
      0,
      rows.findIndex((row) => row.selected),
    );
    const start = Math.min(Math.max(0, selectedRow - Math.floor(limit / 2)), rows.length - limit);
    return rows.slice(start, start + limit);
  }

  handleKey(chord: Chord): PermissionsKeyOutcome {
    if (chord.ctrl || chord.meta) return "stay";
    switch (chord.name) {
      case "escape":
      case "q":
        return "close";
      case "up":
      case "down":
        this.move(chord.name === "down" ? 1 : -1);
        return "stay";
      case "b":
        this.bundleShown = !this.bundleShown;
        this.hooks.notify();
        return "stay";
      case "r":
        this.revokeSelected();
        return "stay";
      case "d":
        this.dropSelected();
        return "stay";
      default:
        return "stay";
    }
  }

  private move(step: number): void {
    const count = this.entries().length;
    if (count === 0) return;
    this.index = (this.index + step + count) % count;
    this.hooks.notify();
  }

  private revokeSelected(): void {
    const entry = this.selected();
    if (entry?.layer !== "workspace") {
      this.hooks.notice("pick a workspace grant to revoke");
      return;
    }
    const label = ruleLabel(entry.rule);
    const revoked = this.port.revokeWorkspace(entry.rule);
    this.hooks.notice(
      revoked
        ? `revoked ${label} · it asks again from the next call on`
        : `${label} was already gone`,
    );
    this.settleIndex();
  }

  private dropSelected(): void {
    const entry = this.selected();
    const session = this.hooks.focused?.session();
    if (entry?.layer !== "session" || session === undefined) {
      this.hooks.notice("pick a session grant to drop");
      return;
    }
    const label = ruleLabel(entry.rule);
    const dropped = session.forget(entry.rule);
    this.hooks.notice(dropped ? `dropped ${label} for this session` : `${label} was already gone`);
    this.settleIndex();
  }

  private settleIndex(): void {
    this.index = Math.min(this.index, Math.max(0, this.entries().length - 1));
    this.hooks.notify();
  }

  private allRows(): ConnectRow[] {
    const view = this.port.view();
    const entries = this.entries();
    const quiet = this.hooks.focused?.lastQuietRun();
    return [
      plain(quietRunLine(quiet), quiet === undefined ? "dim" : "text"),
      ...bundleRows(view, this.bundleShown),
      plain(workspaceHeading(view.workspace, this.port.recordedAt?.())),
      ...grantRows(entries, "workspace", this.index),
      plain(sessionHeading(entries, this.hooks.focused?.session())),
      ...grantRows(entries, "session", this.index),
      plain(permissionsKeyHint, "dim"),
    ];
  }
}

export function quietRunLine(run: QuietRun | undefined): string {
  if (run === undefined) return "nothing has run without asking yet";
  return `ran without asking · ${run.summary} · ${quietReasonLabel(run.reason)}`;
}

export function quietReasonLabel(reason: QuietReason): string {
  switch (reason) {
    case "trusted":
      return "trusted reads";
    case "session":
      return "session grant";
    case "workspace":
      return "workspace grant";
  }
}

export function bundleSummary(view: PermissionsView): string {
  if (!view.trusted) return "trusted reads · off until this folder is trusted";
  const allowed = view.bundle.filter((rule) => rule.effect === "allow").length;
  const asked = view.bundle.length - allowed;
  return `trusted reads · ${allowed} read-only commands run, ${asked} write forms still ask · fixed in keywork, your rules win`;
}

function bundleRows(view: PermissionsView, shown: boolean): ConnectRow[] {
  const summary = plain(bundleSummary(view));
  if (!shown || !view.trusted) return [summary];
  const labels = (effect: PermissionRule["effect"]) =>
    view.bundle.filter((rule) => rule.effect === effect).map((rule) => rule.resource);
  return [
    summary,
    ...chunked(labels("allow"), bundleRowWidth).map((line) => plain(`  ${line}`, "dim")),
    plain("  still asks:", "dim"),
    ...chunked(labels("ask"), bundleRowWidth).map((line) => plain(`  ${line}`, "dim")),
  ];
}

function workspaceHeading(rules: readonly PermissionRule[], recordedAt: Date | undefined): string {
  if (rules.length === 0) return "workspace grants · none yet";
  const stamp = recordedAt === undefined ? "" : ` · last changed ${localStamp(recordedAt)}`;
  return `workspace grants${stamp}`;
}

function sessionHeading(
  entries: readonly GrantEntry[],
  session: SessionGrantsPort | undefined,
): string {
  if (session === undefined) return "session grants · open a conversation to see this pane's";
  return entries.some((entry) => entry.layer === "session")
    ? "session grants · this pane"
    : "session grants · none this session";
}

function grantRows(
  entries: readonly GrantEntry[],
  layer: GrantEntry["layer"],
  index: number,
): ConnectRow[] {
  return entries.flatMap((entry, at) =>
    entry.layer === layer ? [grantRow(entry, at === index)] : [],
  );
}

function grantRow(entry: GrantEntry, selected: boolean): ConnectRow {
  return {
    selected,
    spans: [span(selected ? "▸ " : "  ", "accent"), span(ruleLabel(entry.rule))],
  };
}

const bundleRowWidth = 88;

function chunked(items: readonly string[], widest: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const next = line === "" ? item : `${line} · ${item}`;
    if (next.length > widest && line !== "") {
      lines.push(line);
      line = item;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function callSummary(call: ToolCallPart): string {
  const command = (call.arguments as { command?: unknown } | null)?.command;
  if (call.name === "bash" && typeof command === "string") return command;
  return `${call.name} ${compactJson(call.arguments)}`;
}

function localStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function plain(text: string, tone: ConnectTone = "text"): ConnectRow {
  return { selected: false, spans: [span(text, tone)] };
}

function span(text: string, tone: ConnectTone = "text"): ConnectSpan {
  return { text, tone };
}
