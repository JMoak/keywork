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
}

export type AskVerdict = "granted" | "denied";
export type { Denial, DenyReason } from "@keywork/engine";

export type AnswerOutcome = "settled" | "missing" | "already-settled" | GrantRefusal;

export interface GrantSink {
  record(sessionId: string, scope: GrantedScope, rules: readonly PermissionRule[]): void;
  grantsQuietly?(sessionId: string, call: ToolCallPart, rule: AskRule): boolean;
}

export interface AskQueueOptions {
  timeoutMs?: number;
  now?: () => Date;
  grants?: GrantSink;
  decider?: AskDecider;
}

export type AskDecider = (
  ask: PendingAsk,
  announced: PermissionAsk | undefined,
) => Promise<Confirmation | undefined>;

export const defaultAskTimeoutMs = 120_000;

export class AskQueue {
  private readonly pending = new Map<string, Waiting>();
  private readonly settled: string[] = [];
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly grants: GrantSink | undefined;
  private decider: AskDecider | undefined;

  constructor(options: AskQueueOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? defaultAskTimeoutMs;
    this.now = options.now ?? (() => new Date());
    this.grants = options.grants;
    this.decider = options.decider;
  }

  decideWith(decider: AskDecider | undefined): void {
    this.decider = decider;
  }

  guardFor(sessionId: string, options: { decide?: boolean } = {}): ToolGuard {
    return {
      confirm: (call, announced) => this.ask(sessionId, call, announced, options.decide !== false),
      grantsQuietly: (call, rule) => this.grants?.grantsQuietly?.(sessionId, call, rule) === true,
      gate: "headless",
    };
  }

  ask(
    sessionId: string,
    call: ToolCallPart,
    announced?: PermissionAsk,
    decide = true,
  ): Promise<Confirmation> {
    return new Promise((resolve) => {
      const preview = announced?.preview;
      const ask: PendingAsk = {
        sessionId,
        callId: call.callId,
        tool: call.name,
        arguments: call.arguments,
        rules: grantCandidates(call.name, call.arguments),
        ...(preview !== undefined && { preview }),
        askedAt: this.now().toISOString(),
      };
      const timer = setTimeout(() => this.settle(call.callId, "timed-out"), this.timeoutMs);
      timer.unref?.();
      this.pending.set(call.callId, { ask, resolve, timer });
      if (decide) void this.decide(ask, announced);
    });
  }

  list(): PendingAsk[] {
    return [...this.pending.values()].map(({ ask }) => ask);
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
    if (granted !== "once") {
      const refusal = grantRefusal(waiting.ask.tool, waiting.ask.rules);
      if (refusal !== undefined) return refusal;
      this.grants?.record(waiting.ask.sessionId, granted, waiting.ask.rules);
    }
    this.settle(callId, verdict, granted, denial);
    return "settled";
  }

  close(): void {
    for (const callId of [...this.pending.keys()]) this.settle(callId, "closed");
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
    waiting.resolve(decided);
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
    this.remember(callId);
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
  }

  private remember(callId: string): void {
    this.settled.push(callId);
    if (this.settled.length > rememberedSettlements) this.settled.shift();
  }
}

const rememberedSettlements = 200;

type Unanswered = "timed-out" | "closed";

const unansweredConfirmations: Readonly<Record<Unanswered, Confirmation>> = {
  "timed-out": { approved: false, gate: "headless", timedOut: true },
  closed: { approved: false, gate: "headless" },
};

function isUnanswered(outcome: AskVerdict | Unanswered): outcome is Unanswered {
  return outcome in unansweredConfirmations;
}

interface Waiting {
  ask: PendingAsk;
  resolve: (confirmation: Confirmation) => void;
  timer: ReturnType<typeof setTimeout>;
}
