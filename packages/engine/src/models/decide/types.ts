import type { ModelReference } from "../../inference/types.ts";

export interface Decider {
  readonly reference: ModelReference;
  decide(request: DecisionRequest): Promise<DecideReply>;
}

export interface DecisionRequest {
  state: DecisionState;
  questions: Readonly<Record<string, DecisionQuestion>>;
  signal?: AbortSignal | undefined;
}

export type DecisionState = string | DecisionObject;

export type DecisionJson =
  | string
  | number
  | boolean
  | null
  | readonly DecisionJson[]
  | DecisionObject;

export interface DecisionObject {
  readonly [field: string]: DecisionJson;
}

export type DecisionQuestion =
  | {
      type: "noul";
      instructions: string;
      criteria?: { true?: string; false?: string } | undefined;
    }
  | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string | null>> }
  | { type: "score"; instructions: string; criteria: readonly string[] };

export type DecisionAnswer =
  | { type: "noul"; pYes: number; confidence: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Readonly<Record<string, number>>;
      confidence: number;
    }
  | { type: "score"; score: number; probabilities: readonly number[]; confidence: number }
  | { type: "refusal"; reason: string };

export interface DecisionCost {
  usd: number;
  source: "provider" | "price_table";
}

export interface DecisionUsage {
  inputTokens: number | null;
  questions: number;
  cost: DecisionCost | null;
}

export type DecideReply =
  | {
      ok: true;
      model: string;
      answers: Readonly<Record<string, DecisionAnswer>>;
      usage: DecisionUsage;
      latencyMs: number;
    }
  | { ok: false; failure: DecideFailure };

export type DecideFailureReason =
  | "unreachable"
  | "refused"
  | "rate-limited"
  | "saturated"
  | "overloaded"
  | "model-not-found"
  | "rejected"
  | "malformed"
  | "oversize";

export interface DecideFailure {
  reason: DecideFailureReason;
  message: string;
  status?: number | undefined;
}
