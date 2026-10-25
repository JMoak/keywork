import type {
  EngineEvents,
  PermissionDecision,
  PermissionsView,
  ToolCallPart,
} from "@keywork/engine";
import { type PermissionRule, ruleLabel, toError } from "@keywork/shared";
import type { ConnectRow, ConnectSpan, ConnectTone } from "./connect-model.ts";
import type { Chord } from "./keys.ts";
import { compactJson } from "./transcript-feed.ts";

export type PermissionsSeat = "pane" | "attached";

export interface PermissionsPort {
  readonly seat: PermissionsSeat;
  view(): Promise<PermissionsView>;
  revokeWorkspace(rule: PermissionRule): Promise<boolean>;
  recordedAt?(): Date | undefined;
  sessionGrants?(sessionId: string): SessionGrantsPort;
}

export interface SessionGrantsPort {
  rules(): Promise<readonly PermissionRule[]>;
  forget(rule: PermissionRule): Promise<boolean>;
}

export interface FocusedPermissionsPort {
  session(): SessionGrantsPort | undefined;
  lastQuietRun(): QuietRun | undefined;
}

export type QuietReason = "trusted" | "quiet" | "session" | "workspace";

export interface QuietRun {
  summary: string;
  reason: QuietReason;
  shellEscape?: true;
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

export const permissionsKeyHint = "↑↓ pick · r revokes the grant · b shows the bundle";

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

  noteShellEscape(call: ToolCallPart, decision: PermissionDecision): void {
    this.settle(call, decision, { shellEscape: true });
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

  private settle(
    call: ToolCallPart,
    decision: PermissionDecision,
    origin: Pick<QuietRun, "shellEscape"> = {},
  ): void {
    const reason = quietReasonOf(decision);
    if (reason !== undefined) this.last = { summary: callSummary(call), reason, ...origin };
  }
}

export function quietReasonOf(decision: PermissionDecision): QuietReason | undefined {
  if (decision.verdict !== "granted" || decision.asked === true) return undefined;
  if (decision.gate === "trusted") return "trusted";
  if (decision.gate === "quiet") return "quiet";
  if (decision.gate === "user" && decision.scope !== undefined && decision.scope !== "once") {
    return decision.scope;
  }
  return undefined;
}

export class PermissionsModel {
  index = 0;
  bundleShown = false;
  private state: GrantsState = { kind: "reading" };
  private reads = 0;

  constructor(
    private readonly port: PermissionsPort,
    private readonly hooks: PermissionsHooks,
  ) {}

  async refresh(): Promise<void> {
    this.reads += 1;
    const read = this.reads;
    const next = await this.readGrants();
    if (read !== this.reads) return;
    this.state = next;
    this.index = Math.min(this.index, Math.max(0, this.entries().length - 1));
    this.hooks.notify();
  }

  entries(): GrantEntry[] {
    if (this.state.kind !== "read") return [];
    const { view, session } = this.state.grants;
    return [
      ...view.workspace.map((rule) => ({ layer: "workspace" as const, rule })),
      ...(session ?? []).map((rule) => ({ layer: "session" as const, rule })),
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
        void this.revokeSelected();
        return "stay";
      default:
        return "stay";
    }
  }

  private async readGrants(): Promise<GrantsState> {
    try {
      const sessionGrants = this.hooks.focused?.session();
      const [view, session] = await Promise.all([this.port.view(), sessionGrants?.rules()]);
      return { kind: "read", grants: { view, session } };
    } catch (cause) {
      return { kind: "failed", reason: toError(cause).message };
    }
  }

  private move(step: number): void {
    const count = this.entries().length;
    if (count === 0) return;
    this.index = (this.index + step + count) % count;
    this.hooks.notify();
  }

  private async revokeSelected(): Promise<void> {
    const entry = this.selected();
    if (entry === undefined) {
      this.hooks.notice("nothing to revoke · pick a grant first");
      return;
    }
    const revoke = this.revocationOf(entry);
    if (revoke === undefined) {
      this.hooks.notice("open a conversation to revoke its session grants");
      return;
    }
    const label = ruleLabel(entry.rule);
    await this.settleChange(revoke(), label, {
      done: `revoked ${label} ${revokedReach[entry.layer]} · it asks again from the next call on`,
      failed: `couldn't revoke ${label}`,
    });
  }

  private revocationOf(entry: GrantEntry): (() => Promise<boolean>) | undefined {
    if (entry.layer === "workspace") return () => this.port.revokeWorkspace(entry.rule);
    const session = this.hooks.focused?.session();
    return session === undefined ? undefined : () => session.forget(entry.rule);
  }

  private async settleChange(
    change: Promise<boolean>,
    label: string,
    notices: { done: string; failed: string },
  ): Promise<void> {
    try {
      this.hooks.notice((await change) ? notices.done : `${label} was already gone`);
    } catch (cause) {
      this.hooks.notice(`${notices.failed} · ${toError(cause).message}`);
    }
    await this.refresh();
  }

  private allRows(): ConnectRow[] {
    switch (this.state.kind) {
      case "reading":
        return [plain("checking grants", "dim"), plain(permissionsKeyHint, "dim")];
      case "failed":
        return [
          plain(`can't read grants · ${this.state.reason}`, "danger"),
          plain(permissionsKeyHint, "dim"),
        ];
      case "read":
        return this.grantRows(this.state.grants);
    }
  }

  private grantRows({ view, session }: Grants): ConnectRow[] {
    const entries = this.entries();
    const quiet = this.hooks.focused?.lastQuietRun();
    const firstEncounter = quiet === undefined && entries.length === 0;
    return [
      firstEncounter
        ? plain(firstEncounterLine(view, this.port.seat))
        : plain(quietRunLine(quiet), quiet === undefined ? "dim" : "text"),
      ...bundleRows(view, this.bundleShown),
      plain(workspaceHeading(view.workspace, this.port.recordedAt?.())),
      ...grantRows(entries, "workspace", this.index),
      plain(sessionHeading(session)),
      ...grantRows(entries, "session", this.index),
      plain(permissionsKeyHint, "dim"),
    ];
  }
}

export function firstEncounterLine(view: PermissionsView, seat: PermissionsSeat): string {
  const opening = view.trusted ? "trusted reads just run" : "nothing's granted yet";
  return `${opening} · ${howGrantsHappen[seat]}`;
}

export function quietRunLine(run: QuietRun | undefined): string {
  if (run === undefined) return "nothing has run without asking yet";
  const what = run.shellEscape === true ? `shell escape !${run.summary}` : run.summary;
  return `ran without asking · ${what} · ${quietReasonLabel(run.reason)}`;
}

export function quietReasonLabel(reason: QuietReason): string {
  switch (reason) {
    case "trusted":
      return "trusted reads";
    case "quiet":
      return "quiet mode";
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
  return `trusted reads · ${allowed} read-only commands run, ${asked} write forms ask · your rules win`;
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

function sessionHeading(session: readonly PermissionRule[] | undefined): string {
  if (session === undefined) return "session grants · open a conversation to see this pane's";
  return session.length > 0 ? "session grants · this pane" : "session grants · none this session";
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

interface Grants {
  view: PermissionsView;
  session: readonly PermissionRule[] | undefined;
}

type GrantsState =
  | { kind: "reading" }
  | { kind: "read"; grants: Grants }
  | { kind: "failed"; reason: string };

const revokedReach: Readonly<Record<GrantEntry["layer"], string>> = {
  workspace: "for this workspace",
  session: "for this session",
};

const howGrantsHappen: Readonly<Record<PermissionsSeat, string>> = {
  pane: "[a] on an ask grants this session, the app can grant the workspace",
  attached: "grants come from answering an ask in the app with a scope",
};

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
