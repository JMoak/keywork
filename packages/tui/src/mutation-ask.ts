import type { Confirmation, DenyReason, ToolCallPart } from "@keywork/engine";
import { grantCandidates, type PermissionRule, SessionGrants } from "@keywork/shared";
import { type DiffLine, type FileReader, mutationDiff } from "./diff-render.ts";
import type { Chord } from "./keys.ts";
import { compactJson } from "./transcript-feed.ts";

export type AskStage = "verdict" | "reason";

export interface AskAnswer {
  allowed: boolean;
  reason?: DenyReason;
}

export interface PendingAsk {
  summary: string;
  diff?: DiffLine[];
  remembers: readonly PermissionRule[];
  call: ToolCallPart;
  stage: AskStage;
  resolve(answer: AskAnswer): void;
}

export interface AskDiffWindow {
  lines: DiffLine[];
  above: number;
  below: number;
}

export class MutationAsk {
  private readonly asks: PendingAsk[] = [];
  private readonly grants = new SessionGrants();
  private closed = false;
  private scroll = 0;

  constructor(
    private readonly notify: () => void,
    private readonly readFile?: FileReader,
  ) {}

  get pending(): PendingAsk | undefined {
    return this.asks[0];
  }

  get sessionRules(): readonly PermissionRule[] {
    return this.grants.rules;
  }

  forgetSessionRule(rule: PermissionRule): boolean {
    return this.grants.forget(rule);
  }

  confirm(call: ToolCallPart): Promise<boolean> {
    return this.answered(call).then((answer) => answer.allowed);
  }

  confirmation(call: ToolCallPart): Promise<Confirmation> {
    if (!this.closed && this.grants.covers(call.name, call.arguments)) {
      return Promise.resolve(coveredBySessionGrant);
    }
    return this.answered(call).then(({ allowed, reason }) => ({
      approved: allowed,
      gate: "user",
      ...(reason !== undefined && { reason }),
    }));
  }

  diffWindow(rows: number): AskDiffWindow {
    const diff = this.pending?.diff ?? [];
    this.scroll = Math.min(Math.max(0, this.scroll), Math.max(0, diff.length - rows));
    const start = this.scroll;
    const end = Math.min(diff.length, start + rows);
    return { lines: diff.slice(start, end), above: start, below: diff.length - end };
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    const ask = this.pending;
    if (ask === undefined) return false;
    if (ask.diff !== undefined && this.scrollDiff(chord, pageRows)) return true;
    if (ask.stage === "reason") {
      const reason = denyReason(chord);
      if (reason !== undefined) this.answer({ allowed: false, reason });
      return true;
    }
    const verdict = askVerdict(chord);
    if (verdict === undefined) return true;
    if (verdict === "deny") {
      ask.stage = "reason";
      this.notify();
      return true;
    }
    if (verdict === "always") this.grants.remember(ask.call.name, ask.call.arguments);
    this.answer({ allowed: true });
    return true;
  }

  denyAll(): void {
    while (this.asks.length > 0) this.answer({ allowed: false, reason: "not-now" });
  }

  close(): void {
    this.closed = true;
    this.denyAll();
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
        summary: `${call.name} ${compactJson(call.arguments)}`,
        ...(diff !== undefined && { diff }),
        remembers: grantCandidates(call.name, call.arguments),
        call,
        stage: "verdict",
        resolve,
      });
      this.notify();
    });
  }

  private answer(answer: AskAnswer): void {
    const ask = this.asks.shift();
    this.scroll = 0;
    ask?.resolve(answer);
    this.notify();
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

const coveredBySessionGrant: Confirmation = { approved: true, gate: "user", scope: "session" };

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

function denyReason(chord: Chord): DenyReason | undefined {
  if (chord.ctrl || chord.meta) return undefined;
  switch (chord.name) {
    case "u":
      return "unsafe";
    case "n":
      return "not-now";
    case "o":
    case "escape":
    case "return":
    case "enter":
      return "other";
    default:
      return undefined;
  }
}
