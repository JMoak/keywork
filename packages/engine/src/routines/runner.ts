import type { PayloadRef } from "./payload.ts";
import type { GrantRule, Routine, ToolPosture } from "./routine.ts";
import type { RunUsage } from "./run.ts";

export interface CreatureHome {
  slug: string;
  dir: string;
  bot: string;
}

export interface RunRequest {
  runId: string;
  creature: CreatureHome;
  routine: Routine;
  prompt: string;
  posture: ToolPosture;
  grants: readonly GrantRule[];
  payload?: PayloadRef;
}

export type AskVerdict = "granted" | "denied";

export interface RunSignals {
  spent(costUsd: number): void;
  asked(ask: { callId: string; tool: string }): void;
  answered(callId: string, verdict: AskVerdict): void;
}

export interface RunnerResult {
  ended: "completed" | "failed" | "stopped";
  output: string;
  usage: RunUsage | null;
  costUsd: number | null;
  reason: string | null;
}

export interface RunHandle {
  sessionId: string;
  finished: Promise<RunnerResult>;
  stop(): Promise<void>;
  deny(callId: string): Promise<void>;
}

export interface RoutineRunner {
  start(request: RunRequest, signals: RunSignals): Promise<RunHandle>;
}

export interface RoutineThread {
  creature: string;
  bot: string;
  kind: "routine";
  title: string;
  routineId: string;
  runId: string;
}

export type ThreadSignal =
  | { kind: "turn-completed"; text: string; usage: RunUsage; costUsd: number | null }
  | { kind: "turn-interrupted"; text: string }
  | { kind: "error"; message: string }
  | { kind: "spend"; costUsd: number }
  | { kind: "ask"; callId: string; tool: string }
  | { kind: "answered"; callId: string; verdict: AskVerdict };

export interface ThreadHost {
  openThread(thread: RoutineThread): Promise<string>;
  confine(sessionId: string, posture: ToolPosture, grants: readonly GrantRule[]): Promise<void>;
  prompt(sessionId: string, text: string): Promise<"started" | "queued" | "missing">;
  abort(sessionId: string): Promise<unknown>;
  denyAsk(callId: string): Promise<unknown>;
  watch(sessionId: string, listener: (signal: ThreadSignal) => void): () => void;
}

export function threadRunner(host: ThreadHost): RoutineRunner {
  return {
    start: async (request, signals) => {
      const sessionId = await host.openThread(threadOf(request));
      await host.confine(sessionId, request.posture, request.grants);
      const turn = new RoutineTurn(signals);
      const unwatch = host.watch(sessionId, (signal) => turn.observe(signal));
      turn.finished.finally(unwatch);
      if ((await host.prompt(sessionId, request.prompt)) === "missing") {
        turn.fail("the routine's session disappeared before its prompt was accepted");
      }
      return {
        sessionId,
        finished: turn.finished,
        stop: async () => {
          turn.stopping();
          await host.abort(sessionId);
        },
        deny: async (callId) => void (await host.denyAsk(callId)),
      };
    },
  };
}

function threadOf(request: RunRequest): RoutineThread {
  return {
    creature: request.creature.slug,
    bot: request.creature.bot,
    kind: "routine",
    title: request.routine.title,
    routineId: request.routine.id,
    runId: request.runId,
  };
}

class RoutineTurn {
  readonly finished: Promise<RunnerResult>;
  private settle: (result: RunnerResult) => void = () => {};
  private stopRequested = false;
  private costUsd: number | null = null;

  constructor(private readonly signals: RunSignals) {
    this.finished = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  observe(signal: ThreadSignal): void {
    switch (signal.kind) {
      case "turn-completed":
        this.spend(signal.costUsd);
        this.settle(this.result("completed", signal.text, signal.usage, null));
        break;
      case "turn-interrupted":
        this.settle(
          this.stopRequested
            ? this.result("stopped", signal.text, null, null)
            : this.result("failed", signal.text, null, "the turn was interrupted"),
        );
        break;
      case "error":
        this.fail(signal.message);
        break;
      case "spend":
        this.spend(signal.costUsd);
        break;
      case "ask":
        this.signals.asked({ callId: signal.callId, tool: signal.tool });
        break;
      case "answered":
        this.signals.answered(signal.callId, signal.verdict);
        break;
    }
  }

  stopping(): void {
    this.stopRequested = true;
  }

  fail(reason: string): void {
    this.settle(this.result("failed", "", null, reason));
  }

  private spend(costUsd: number | null): void {
    if (costUsd === null) return;
    this.costUsd = costUsd;
    this.signals.spent(costUsd);
  }

  private result(
    ended: RunnerResult["ended"],
    output: string,
    usage: RunUsage | null,
    reason: string | null,
  ): RunnerResult {
    return { ended, output, usage, costUsd: this.costUsd, reason };
  }
}
