import type { ModelReference } from "../../inference/types.ts";
import type { PlannedCandidate, PolicyPlan } from "./resolve.ts";

export type FallbackTrigger =
  | "context-length"
  | "rate-limited"
  | "saturated"
  | "down"
  | "moderation";

export type TerminalReason = "model-not-found" | "credential-refused" | "request-rejected";

export interface CallFailure {
  status?: number | undefined;
  code?: string | undefined;
  message?: string | undefined;
}

export type FailureVerdict =
  | { kind: "fallback"; trigger: FallbackTrigger }
  | { kind: "terminal"; reason: TerminalReason };

export interface CloudFallbackLog {
  from: ModelReference;
  to: ModelReference;
  trigger: FallbackTrigger;
}

export type Streamed = "nothing" | "text" | "tool-call";

export interface FallbackRequest {
  plan: PolicyPlan;
  current: number;
  failure: CallFailure;
  streamed: Streamed;
}

export type FallbackStep =
  | {
      kind: "next";
      index: number;
      candidate: PlannedCandidate;
      trigger: FallbackTrigger;
      cloudFallback?: CloudFallbackLog;
    }
  | { kind: "stop"; reason: TerminalReason | "tool-call-emitted" | "partial-reply" | "exhausted" };

export function classifyFailure(failure: CallFailure): FailureVerdict {
  const text = `${failure.code ?? ""} ${failure.message ?? ""}`.toLowerCase();
  if (failure.status === 404 || modelNotFound.test(text)) return terminal("model-not-found");
  if (contextLength.test(text)) return fallback("context-length");
  if (moderation.test(text)) return fallback("moderation");
  return verdictForStatus(failure.status);
}

export function nextCandidate(request: FallbackRequest): FallbackStep {
  if (request.streamed === "tool-call") return { kind: "stop", reason: "tool-call-emitted" };
  if (request.streamed === "text") return { kind: "stop", reason: "partial-reply" };
  const verdict = classifyFailure(request.failure);
  if (verdict.kind === "terminal") return { kind: "stop", reason: verdict.reason };
  const { candidates } = request.plan;
  const index = request.current + 1;
  const from = candidates[request.current];
  const candidate = candidates[index];
  if (from === undefined || candidate === undefined) return { kind: "stop", reason: "exhausted" };
  const crossesToCloud = from.locality === "local" && candidate.locality === "cloud";
  return {
    kind: "next",
    index,
    candidate,
    trigger: verdict.trigger,
    ...(crossesToCloud && {
      cloudFallback: {
        from: from.binding.reference,
        to: candidate.binding.reference,
        trigger: verdict.trigger,
      },
    }),
  };
}

const modelNotFound =
  /model_not_found|model (["'`][^"'`]*["'`] )?(was )?not found|no such model|unknown model|not a valid model/;

const contextLength =
  /context_length_exceeded|context length|context window|maximum context|prompt is too long|too many tokens|exceeds the context/;

const moderation = /moderation|flagged/;

function verdictForStatus(status: number | undefined): FailureVerdict {
  if (status === undefined) return fallback("down");
  if (status === 429) return fallback("rate-limited");
  if (status === 503) return fallback("saturated");
  if (status === 401 || status === 403) return terminal("credential-refused");
  if (status >= 500) return fallback("down");
  return terminal("request-rejected");
}

function fallback(trigger: FallbackTrigger): FailureVerdict {
  return { kind: "fallback", trigger };
}

function terminal(reason: TerminalReason): FailureVerdict {
  return { kind: "terminal", reason };
}
