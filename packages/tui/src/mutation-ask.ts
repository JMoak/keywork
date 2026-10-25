import type { AskRule, Confirmation, DenyReason, ToolCallPart } from "@keywork/engine";
import { grantCandidates, type PermissionRule, quietGrant, SessionGrants } from "@keywork/shared";
import { type DiffLine, type FileReader, mutationDiff } from "./diff-render.ts";
import type { Chord } from "./keys.ts";
import { compactJson, toolSubject } from "./transcript-feed.ts";

export type AskStage = "verdict" | "reason" | "note";

export interface AskAnswer {
  allowed: boolean;
  remembered?: true;
  reason?: DenyReason;
  note?: string;
}

export interface PendingAsk {
  summary: string;
  diff?: DiffLine[];
  remembers: readonly PermissionRule[];
  call: ToolCallPart;
  stage: AskStage;
  note: string;
  resolve(answer: AskAnswer): void;
}

export interface AskDiffWindow {
  lines: DiffLine[];
  above: number;
  below: number;
}

export type SessionRulesListener = (rules: readonly PermissionRule[]) => void;

export const askArmingMs = 400;

export const askNoteLimit = 1000;

export class MutationAsk {
  quiet = false;
  private readonly asks: PendingAsk[] = [];
  private readonly grants = new SessionGrants();
  private closed = false;
  private scroll = 0;
  private armsAt = unseen;
  private armingPaint: ReturnType<typeof setTimeout> | undefined;
  private rulesChanged: SessionRulesListener | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly readFile?: FileReader,
    private readonly now: () => number = Date.now,
  ) {}

  get pending(): PendingAsk | undefined {
    return this.asks[0];
  }

  get sessionRules(): readonly PermissionRule[] {
    return this.grants.rules;
  }

  armed(): boolean {
    return this.pending !== undefined && this.now() >= this.armsAt;
  }

  seen(): void {
    if (this.pending !== undefined && this.armsAt === unseen) this.holdArming();
  }

  holdArming(): void {
    if (this.pending === undefined) return;
    this.armsAt = this.now() + askArmingMs;
    this.paintOnceArmed();
  }

  adoptSessionRules(rules: readonly PermissionRule[]): void {
    this.grants.adopt(rules);
    this.notify();
  }

  onSessionRulesChanged(listener: SessionRulesListener): void {
    this.rulesChanged = listener;
  }

  forgetSessionRule(rule: PermissionRule): boolean {
    return this.settleRules(this.grants.forget(rule));
  }

  waiting(): { asks: number; tools: string[] } {
    const tools = [...new Set(this.asks.map((ask) => ask.call.name))].sort();
    return { asks: this.asks.length, tools };
  }

  grantQuietly(call: ToolCallPart, rule: AskRule): boolean {
    if (!this.quiet || this.closed || rule === "trusted") return false;
    if (quietGrant(call.name, call.arguments) === undefined) return false;
    this.rememberCall(call);
    this.notify();
    return true;
  }

  confirm(call: ToolCallPart): Promise<boolean> {
    return this.answered(call).then((answer) => answer.allowed);
  }

  confirmation(call: ToolCallPart): Promise<Confirmation> {
    if (!this.closed && this.grants.covers(call.name, call.arguments)) {
      return Promise.resolve(coveredBySessionGrant);
    }
    return this.answered(call).then(confirmationOf);
  }

  diffWindow(rows: number): AskDiffWindow {
    const diff = this.pending?.diff ?? [];
    this.scroll = Math.min(Math.max(0, this.scroll), Math.max(0, diff.length - rows));
    const start = this.scroll;
    const end = Math.min(diff.length, start + rows);
    return { lines: diff.slice(start, end), above: start, below: diff.length - end };
  }

  handleKey(chord: Chord, pageRows: number, sequence?: string): boolean {
    const ask = this.pending;
    if (ask === undefined) return false;
    if (ask.stage === "note") return this.writeNote(ask, chord, sequence);
    if (ask.diff !== undefined && this.scrollDiff(chord, pageRows)) return true;
    if (!this.armed()) return false;
    return ask.stage === "reason" ? this.answerReason(ask, chord) : this.answerVerdict(ask, chord);
  }

  takesPaste(text: string): boolean {
    const ask = this.pending;
    if (ask?.stage !== "note") return false;
    this.extendNote(ask, text.replace(/\s+/g, " "));
    return true;
  }

  denyAll(): void {
    while (this.asks.length > 0) this.answer({ allowed: false, reason: "not-now" });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.armingPaint);
    this.denyAll();
  }

  private answerVerdict(ask: PendingAsk, chord: Chord): boolean {
    const verdict = askVerdict(chord);
    if (verdict === undefined) return false;
    if (verdict === "deny") {
      ask.stage = "reason";
      this.notify();
      return true;
    }
    if (verdict === "always" && ask.remembers.length > 0) {
      this.rememberCall(ask.call);
      this.answer({ allowed: true, remembered: true });
      return true;
    }
    this.answer({ allowed: true });
    return true;
  }

  private answerReason(ask: PendingAsk, chord: Chord): boolean {
    if (isNoteKey(chord)) {
      ask.stage = "note";
      this.notify();
      return true;
    }
    const reason = denyReason(chord);
    if (reason === undefined) return false;
    this.answer({ allowed: false, reason });
    return true;
  }

  private writeNote(ask: PendingAsk, chord: Chord, sequence: string | undefined): true {
    if (chord.name === "escape") this.answer({ allowed: false, reason: "other" });
    else if (chord.name === "return" || chord.name === "enter") this.sendNote(ask);
    else if (chord.name === "backspace") this.trimNote(ask);
    else if (sequence !== undefined && !chord.ctrl && !chord.meta) this.extendNote(ask, sequence);
    return true;
  }

  private sendNote(ask: PendingAsk): void {
    const note = ask.note.trim();
    this.answer({ allowed: false, reason: "other", ...(note !== "" && { note }) });
  }

  private extendNote(ask: PendingAsk, text: string): void {
    ask.note = `${ask.note}${text}`.slice(0, askNoteLimit);
    this.notify();
  }

  private trimNote(ask: PendingAsk): void {
    ask.note = [...ask.note].slice(0, -1).join("");
    this.notify();
  }

  private answered(call: ToolCallPart): Promise<AskAnswer> {
    if (this.closed) return Promise.resolve({ allowed: false, reason: "not-now" });
    if (this.grants.covers(call.name, call.arguments)) return Promise.resolve({ allowed: true });
    return new Promise((resolve) => {
      const diff =
        this.readFile === undefined
          ? undefined
          : mutationDiff(call.name, call.arguments, this.readFile);
      this.asks.push({
        summary: askSummary(call, diff),
        ...(diff !== undefined && { diff }),
        remembers: grantCandidates(call.name, call.arguments),
        call,
        stage: "verdict",
        note: "",
        resolve,
      });
      if (this.asks.length === 1) this.armsAt = unseen;
      this.notify();
    });
  }

  private answer(answer: AskAnswer): void {
    const ask = this.asks.shift();
    this.scroll = 0;
    this.armsAt = unseen;
    ask?.resolve(answer);
    this.notify();
  }

  private rememberCall(call: ToolCallPart): void {
    this.settleRules(this.grants.remember(call.name, call.arguments).length > 0);
  }

  private settleRules(changed: boolean): boolean {
    if (changed) this.rulesChanged?.(this.grants.rules);
    return changed;
  }

  private paintOnceArmed(): void {
    clearTimeout(this.armingPaint);
    this.armingPaint = setTimeout(this.notify, askArmingMs);
    this.armingPaint.unref?.();
  }

  private scrollDiff(chord: Chord, pageRows: number): boolean {
    const steps: Record<string, number> = {
      up: -1,
      down: 1,
      pageup: -pageRows,
      pagedown: pageRows,
    };
    const step = steps[chord.name];
    if (step === undefined) return false;
    this.scroll = Math.max(0, this.scroll + step);
    this.notify();
    return true;
  }
}

export function askSummary(call: ToolCallPart, diff?: readonly DiffLine[]): string {
  const facts = diff === undefined ? [] : diffFacts(diff);
  return [callHeadline(call), ...facts].join(" · ");
}

export function callHeadline(call: ToolCallPart): string {
  const command = (call.arguments as { command?: unknown } | null)?.command;
  if (call.name === "bash" && typeof command === "string") return `bash ${oneLine(command)}`;
  const subject = toolSubject(call.arguments);
  if (subject !== "") return `${call.name} ${subject}`;
  const args = compactJson(call.arguments);
  return args === "" || args === "{}" ? call.name : `${call.name} ${args}`;
}

const unseen = Number.POSITIVE_INFINITY;

const coveredBySessionGrant: Confirmation = {
  approved: true,
  gate: "user",
  scope: "session",
  asked: false,
};

function confirmationOf({ allowed, remembered, reason, note }: AskAnswer): Confirmation {
  return {
    approved: allowed,
    gate: "user",
    ...(remembered === true && { scope: "session" as const }),
    ...(reason !== undefined && { reason }),
    ...(note !== undefined && { note }),
  };
}

function diffFacts(diff: readonly DiffLine[]): string[] {
  const added = diff.filter((line) => line.kind === "add").length;
  const removed = diff.filter((line) => line.kind === "del").length;
  if (diff[0]?.kind === "note" && diff[0].text.startsWith("new file")) {
    return ["new", added === 1 ? "1 line" : `${added} lines`];
  }
  return added + removed === 0 ? [] : [`+${added} -${removed}`];
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function askVerdict(chord: Chord): "allow" | "always" | "deny" | undefined {
  if (chord.ctrl || chord.meta) return undefined;
  switch (chord.name) {
    case "y":
    case "return":
    case "enter":
      return "allow";
    case "a":
      return "always";
    case "n":
    case "escape":
      return "deny";
    default:
      return undefined;
  }
}

function isNoteKey(chord: Chord): boolean {
  return chord.name === "o" && !chord.ctrl && !chord.meta;
}

function denyReason(chord: Chord): DenyReason | undefined {
  if (chord.ctrl || chord.meta) return undefined;
  switch (chord.name) {
    case "u":
      return "unsafe";
    case "n":
      return "not-now";
    case "escape":
    case "return":
    case "enter":
      return "other";
    default:
      return undefined;
  }
}
