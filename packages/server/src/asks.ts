import type {
  Confirmation,
  DenyReason,
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
export type { DenyReason } from "@keywork/engine";

export type AnswerOutcome = "settled" | "missing" | "already-settled" | GrantRefusal;

export interface GrantSink {
  record(sessionId: string, scope: GrantedScope, rules: readonly PermissionRule[]): void;
}

export interface AskQueueOptions {
  timeoutMs?: number;
  now?: () => Date;
  grants?: GrantSink;
}

export const defaultAskTimeoutMs = 120_000;

export class AskQueue {
  private readonly pending = new Map<string, Waiting>();
  private readonly settled: string[] = [];
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly grants: GrantSink | undefined;

  constructor(options: AskQueueOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? defaultAskTimeoutMs;
    this.now = options.now ?? (() => new Date());
    this.grants = options.grants;
  }

  guardFor(sessionId: string): ToolGuard {
    return { confirm: (call, announced) => this.ask(sessionId, call, announced), gate: "headless" };
  }

  ask(sessionId: string, call: ToolCallPart, announced?: PermissionAsk): Promise<Confirmation> {
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
    });
  }

  list(): PendingAsk[] {
    return [...this.pending.values()].map(({ ask }) => ask);
  }

  answer(
    callId: string,
    verdict: AskVerdict,
    scope: AskScope = "once",
    reason?: DenyReason,
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
    this.settle(callId, verdict, granted, reason);
    return "settled";
  }

  close(): void {
    for (const callId of [...this.pending.keys()]) this.settle(callId, "timed-out");
  }

  private settle(
    callId: string,
    outcome: AskVerdict | "timed-out",
    scope?: AskScope,
    reason?: DenyReason,
  ): void {
    const waiting = this.pending.get(callId);
    if (waiting === undefined) return;
    this.pending.delete(callId);
    clearTimeout(waiting.timer);
    this.remember(callId);
    waiting.resolve(
      outcome === "timed-out"
        ? { approved: false, gate: "headless" }
        : {
            approved: outcome === "granted",
            gate: "user",
            ...(outcome === "granted" && scope !== undefined && { scope }),
            ...(outcome === "denied" && reason !== undefined && { reason }),
          },
    );
  }

  private remember(callId: string): void {
    this.settled.push(callId);
    if (this.settled.length > rememberedSettlements) this.settled.shift();
  }
}

const rememberedSettlements = 200;

interface Waiting {
  ask: PendingAsk;
  resolve: (confirmation: Confirmation) => void;
  timer: ReturnType<typeof setTimeout>;
}
