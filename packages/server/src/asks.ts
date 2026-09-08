import type { Confirmation, ToolCallPart, ToolGuard } from "@keywork/engine";

export interface PendingAsk {
  sessionId: string;
  callId: string;
  tool: string;
  arguments: unknown;
  askedAt: string;
}

export type AskVerdict = "granted" | "denied";

export type AnswerOutcome = "settled" | "missing" | "already-settled";

export interface AskQueueOptions {
  timeoutMs?: number;
  now?: () => Date;
}

export const defaultAskTimeoutMs = 120_000;

export class AskQueue {
  private readonly pending = new Map<string, Waiting>();
  private readonly settled: string[] = [];
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: AskQueueOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? defaultAskTimeoutMs;
    this.now = options.now ?? (() => new Date());
  }

  guardFor(sessionId: string): ToolGuard {
    return { confirm: (call) => this.ask(sessionId, call), gate: "headless" };
  }

  ask(sessionId: string, call: ToolCallPart): Promise<Confirmation> {
    return new Promise((resolve) => {
      const ask: PendingAsk = {
        sessionId,
        callId: call.callId,
        tool: call.name,
        arguments: call.arguments,
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

  answer(callId: string, verdict: AskVerdict): AnswerOutcome {
    if (this.pending.has(callId)) {
      this.settle(callId, verdict);
      return "settled";
    }
    return this.settled.includes(callId) ? "already-settled" : "missing";
  }

  close(): void {
    for (const callId of [...this.pending.keys()]) this.settle(callId, "timed-out");
  }

  private settle(callId: string, outcome: AskVerdict | "timed-out"): void {
    const waiting = this.pending.get(callId);
    if (waiting === undefined) return;
    this.pending.delete(callId);
    clearTimeout(waiting.timer);
    this.remember(callId);
    waiting.resolve(
      outcome === "timed-out"
        ? { approved: false, gate: "headless" }
        : { approved: outcome === "granted", gate: "user" },
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
