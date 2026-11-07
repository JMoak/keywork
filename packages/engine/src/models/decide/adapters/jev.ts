import type { AuthHeaders, FetchLike } from "../../../providers/transport.ts";
import type { Decider, DecisionRequest } from "../types.ts";
import { systemOneDecider, wireRequestOf } from "./systemone.ts";

export const jevOnOpenRouter = {
  provider: "openrouter",
  endpoint: "https://openrouter.ai/api/v1",
  model: "typesafe/jev-1.14",
} as const;

export const jevTextLimitBytes = 32 * 1024;

export interface JevOptions {
  authHeaders: AuthHeaders;
  model?: string | undefined;
  provider?: string | undefined;
  endpoint?: string | undefined;
  fetchFn?: FetchLike | undefined;
  clock?: (() => number) | undefined;
}

export class UnpinnedDecisionModelError extends Error {
  constructor(readonly model: string) {
    super(
      `${model} is an alias that moves between versions; pin a version such as ${jevOnOpenRouter.model} so thresholds stay with the model they were fitted on`,
    );
    this.name = "UnpinnedDecisionModelError";
  }
}

export function jevViaOpenRouter(options: JevOptions): Decider {
  const model = options.model ?? jevOnOpenRouter.model;
  if (isAlias(model)) throw new UnpinnedDecisionModelError(model);
  const inner = systemOneDecider({
    reference: { provider: options.provider ?? jevOnOpenRouter.provider, model },
    endpoint: options.endpoint ?? jevOnOpenRouter.endpoint,
    authHeaders: options.authHeaders,
    fetchFn: options.fetchFn,
    clock: options.clock,
  });
  return {
    reference: inner.reference,
    decide: async (request) => {
      const bytes = requestTextBytes(model, request);
      if (bytes <= jevTextLimitBytes) return inner.decide(request);
      return {
        ok: false,
        failure: {
          reason: "oversize",
          message: `${bytes} bytes of text is over Jev's ${jevTextLimitBytes}-byte short-context limit; split the state`,
        },
      };
    },
  };
}

function isAlias(model: string): boolean {
  return model.startsWith("~") || model.endsWith("-latest");
}

function requestTextBytes(model: string, request: DecisionRequest): number {
  return new TextEncoder().encode(wireRequestOf(model, request)).byteLength;
}
