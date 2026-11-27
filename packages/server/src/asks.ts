import type {
  AskRule,
  Confirmation,
  Denial,
  GrantedScope,
  PermissionAsk,
  ToolCallPart,
  ToolGuard,
  ToolPreview,
} from "@keywork/engine";
import {
  type AskScope,
  type GrantRefusal,
  grantCandidates,
  grantRefusal,
  type PermissionRule,
} from "@keywork/shared";

export interface PendingAsk {
  sessionId: string;
  callId: string;
  tool: string;
  arguments: unknown;
  rules: PermissionRule[];
  preview?: ToolPreview;
  askedAt: string;
  carried?: true;
}

export interface KeptAsk extends PendingAsk {
  rule: AskRule;
}

export interface AskKeeping {
  read(): readonly KeptAsk[];
  write(asks: readonly KeptAsk[]): void;
}

export interface CarriedAnswer {
  verdict: AskVerdict;
  denial: Denial;
}

export type CarriedResume = (ask: KeptAsk, answer: CarriedAnswer) => void;

export type AskVerdict = "granted" | "denied";
export type { Denial, DenyReason } from "@keywork/engine";

export type AnswerOutcome =
  | "settled"
  | "missing"
  | "already-settled"
  | "carried-once"
  | GrantRefusal;

export type AskEnding = "granted" | "denied" | "lapsed";

export interface AskFollower {
  asked(ask: PendingAsk): void;
  settled(ask: PendingAsk, ending: AskEnding): void;
}

export interface GrantSink {
  record(sessionId: string, scope: GrantedScope, rules: readonly PermissionRule[]): void;
  grantsQuietly?(sessionId: string, call: ToolCallPart, rule: AskRule): boolean;
}

export interface AskQueueOptions {
  timeoutMs?: number;
  now?: () => Date;
  grants?: GrantSink;
  decider?: AskDecider;
  keeping?: AskKeeping;
}

export type AskDecider = (
  ask: PendingAsk,
  announced: PermissionAsk | undefined,
) => Promise<Confirmation | undefined>;

// A question waits for its keeper for a week. It used to lapse after two minutes, which left a
// creature's ledger full of questions nobody had been given the time to answer.
export const defaultAskTimeoutMs = 7 * 24 * 60 * 60 * 1000;

export class AskQueue {
  private readonly pending = new Map<string, Waiting>();
  private readonly settled: string[] = [];
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly grants: GrantSink | undefined;
  private readonly followers = new Set<AskFollower>();
  private readonly keeping: AskKeeping | undefined;
  private readonly allowed = new Map<string, string[]>();
  private decider: AskDecider | undefined;
  private resume: CarriedResume | undefined;

  constructor(options: AskQueueOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? defaultAskTimeoutMs;
    this.now = options.now ?? (() => new Date());
    this.grants = options.grants;
    this.decider = options.decider;
    this.keeping = options.keeping;
    for (const kept of this.keeping?.read() ?? []) this.carry(kept);
  }

  decideWith(decider: AskDecider | undefined): void {
    this.decider = decider;
  }

  resumeWith(resume: CarriedResume | undefined): void {
    this.resume = resume;
  }

  follow(follower: AskFollower): () => void {
    this.followers.add(follower);
    for (const { ask } of this.pending.values()) {
      if (ask.carried === true) follower.asked(ask);
    }
    return () => this.followers.delete(follower);
  }

  guardFor(sessionId: string, options: { decide?: boolean } = {}): ToolGuard {
    return {
      confirm: (call, announced) => this.ask(sessionId, call, announced, options.decide !== false),
      grantsQuietly: (call, rule) => this.grants?.grantsQuietly?.(sessionId, call, rule) === true,
      answeredBefore: (call) => this.takeAllowance(sessionId, call),
      gate: "headless",
    };
  }

  forgetAllowances(sessionId: string): void {
    this.allowed.delete(sessionId);
  }

  ask(
    sessionId: string,
    call: ToolCallPart,
    announced?: PermissionAsk,
    decide = true,
  ): Promise<Confirmation> {
    return new Promise((resolve) => {
      const preview = announced?.preview;
      const ask: KeptAsk = {
        sessionId,
        callId: call.callId,
        tool: call.name,
        arguments: call.arguments,
        rules: grantCandidates(call.name, call.arguments),
        ...(preview !== undefined && { preview }),
        askedAt: this.now().toISOString(),
        rule: announced?.rule ?? "default",
      };
      this.pending.set(call.callId, { ask, resolve, timer: this.lapseAfter(call.callId) });
      this.keep();
      for (const follower of [...this.followers]) follower.asked(publicOf(ask));
      if (decide && announced?.rule !== "always") void this.decide(publicOf(ask), announced);
    });
  }

  list(): PendingAsk[] {
    return [...this.pending.values()].map(({ ask }) => publicOf(ask));
  }

  answer(
    callId: string,
    verdict: AskVerdict,
    scope: AskScope = "once",
    denial: Denial = {},
  ): AnswerOutcome {
    const waiting = this.pending.get(callId);
    if (waiting === undefined) {
      return this.settled.includes(callId) ? "already-settled" : "missing";
    }
    const granted: AskScope = verdict === "granted" ? scope : "once";
    if (granted !== "once" && waiting.ask.carried === true) return "carried-once";
    if (granted !== "once") {
      const refusal = grantRefusal(waiting.ask.tool, waiting.ask.rules);
      if (refusal !== undefined) return refusal;
      this.grants?.record(waiting.ask.sessionId, granted, waiting.ask.rules);
    }
    this.settle(callId, verdict, granted, denial);
    return "settled";
  }

  close(): void {
    for (const callId of [...this.pending.keys()]) this.settle(callId, "stopped");
  }

  closeFor(sessionId: string): void {
    for (const [callId, waiting] of this.pending) {
      if (waiting.ask.sessionId === sessionId) this.settle(callId, "closed");
    }
  }

  private async decide(ask: PendingAsk, announced: PermissionAsk | undefined): Promise<void> {
    if (this.decider === undefined) return;
    const decided = await this.decider(ask, announced).catch(() => undefined);
    const waiting = this.pending.get(ask.callId);
    if (decided === undefined || waiting === undefined) return;
    this.pending.delete(ask.callId);
    clearTimeout(waiting.timer);
    this.remember(ask.callId);
    this.keep();
    waiting.resolve(decided);
    this.ended(waiting.ask, approves(decided) ? "granted" : "denied");
  }

  private carry(kept: KeptAsk): void {
    const lapsesIn = Date.parse(kept.askedAt) + this.timeoutMs - this.now().getTime();
    if (!(lapsesIn > 0)) return;
    const ask: KeptAsk = { ...kept, carried: true };
    const resolve = (confirmation: Confirmation) => this.carriedAnswered(ask, confirmation);
    this.pending.set(ask.callId, { ask, resolve, timer: this.lapseAfter(ask.callId, lapsesIn) });
  }

  private carriedAnswered(ask: KeptAsk, confirmation: Confirmation): void {
    if (typeof confirmation === "boolean" || confirmation.gate !== "user") return;
    const verdict = confirmation.approved ? "granted" : "denied";
    if (verdict === "granted") {
      const allowed = this.allowed.get(ask.sessionId) ?? [];
      this.allowed.set(ask.sessionId, [...allowed, callKey(ask.tool, ask.arguments)]);
    }
    const denial: Denial = {
      ...(confirmation.reason !== undefined && { reason: confirmation.reason }),
      ...(confirmation.note !== undefined && { note: confirmation.note }),
    };
    this.resume?.(ask, { verdict, denial });
  }

  private takeAllowance(sessionId: string, call: ToolCallPart): boolean {
    const allowed = this.allowed.get(sessionId) ?? [];
    const at = allowed.indexOf(callKey(call.name, call.arguments));
    if (at < 0) return false;
    this.allowed.set(
      sessionId,
      allowed.filter((_, index) => index !== at),
    );
    return true;
  }

  private lapseAfter(callId: string, ms = this.timeoutMs): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.settle(callId, "timed-out"), ms);
    timer.unref?.();
    return timer;
  }

  private keep(): void {
    this.keeping?.write([...this.pending.values()].map(({ ask }) => ask));
  }

  private settle(
    callId: string,
    outcome: AskVerdict | Unanswered,
    scope?: AskScope,
    denial: Denial = {},
  ): void {
    const waiting = this.pending.get(callId);
    if (waiting === undefined) return;
    this.pending.delete(callId);
    clearTimeout(waiting.timer);
    if (outcome === "stopped") {
      waiting.resolve(unansweredConfirmations.stopped);
      return;
    }
    this.remember(callId);
    this.keep();
    waiting.resolve(
      isUnanswered(outcome)
        ? unansweredConfirmations[outcome]
        : {
            approved: outcome === "granted",
            gate: "user",
            ...(outcome === "granted" && scope !== undefined && { scope }),
            ...(outcome === "denied" && denial),
          },
    );
    this.ended(waiting.ask, isUnanswered(outcome) ? "lapsed" : outcome);
  }

  private ended(ask: KeptAsk, ending: AskEnding): void {
    for (const follower of [...this.followers]) follower.settled(publicOf(ask), ending);
  }

  private remember(callId: string): void {
    this.settled.push(callId);
    if (this.settled.length > rememberedSettlements) this.settled.shift();
  }
}

const rememberedSettlements = 200;

type Unanswered = "timed-out" | "closed" | "stopped";

const unansweredConfirmations: Readonly<Record<Unanswered, Confirmation>> = {
  "timed-out": { approved: false, gate: "headless", timedOut: true },
  closed: { approved: false, gate: "headless" },
  stopped: { approved: false, gate: "headless", carried: true },
};

function publicOf({ rule: _rule, ...ask }: KeptAsk): PendingAsk {
  return ask;
}

function callKey(tool: string, args: unknown): string {
  return `${tool}\n${stableJson(args)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isUnanswered(outcome: AskVerdict | Unanswered): outcome is Unanswered {
  return outcome in unansweredConfirmations;
}

function approves(confirmation: Confirmation): boolean {
  return typeof confirmation === "boolean" ? confirmation : confirmation.approved;
}

interface Waiting {
  ask: KeptAsk;
  resolve: (confirmation: Confirmation) => void;
  timer: ReturnType<typeof setTimeout>;
}
