import type { Provider, ProviderRequest, TurnDelta } from "../../provider.ts";
import { ProviderHttpError } from "../../providers/errors.ts";
import {
  type CallFailure,
  type CloudFallbackLog,
  type FallbackTrigger,
  nextCandidate,
  type Streamed,
} from "./fallback.ts";
import type { PlannedCandidate, PolicyPlan } from "./resolve.ts";

export interface FallbackProviderOptions {
  plan: PolicyPlan;
  open(candidate: PlannedCandidate): Provider;
  onFallback?: ((event: FallbackSwitch) => void) | undefined;
}

export interface FallbackSwitch {
  from: PlannedCandidate;
  to: PlannedCandidate;
  trigger: FallbackTrigger;
  cloudFallback?: CloudFallbackLog | undefined;
}

export function fallbackProvider(options: FallbackProviderOptions): Provider {
  const [primary] = options.plan.candidates;
  const opened = options.open(primary);
  return {
    name: opened.name,
    modelId: opened.modelId,
    capabilities: opened.capabilities,
    stream: (request) => streamWithFallback(options, opened, request),
  };
}

export function callFailureOf(error: unknown): CallFailure {
  if (error instanceof ProviderHttpError) return { status: error.status, message: error.message };
  return { message: error instanceof Error ? error.message : String(error) };
}

async function* streamWithFallback(
  options: FallbackProviderOptions,
  primary: Provider,
  request: ProviderRequest,
): AsyncIterable<TurnDelta> {
  let index = 0;
  let provider = primary;
  for (;;) {
    let streamed: Streamed = "nothing";
    try {
      for await (const delta of provider.stream(request)) {
        streamed = streamedAfter(streamed, delta);
        yield delta;
      }
      return;
    } catch (error) {
      if (request.signal?.aborted || request.retry === "never") throw error;
      const failure = callFailureOf(error);
      const step = nextCandidate({ plan: options.plan, current: index, failure, streamed });
      if (step.kind === "stop") throw error;
      const from = options.plan.candidates[index];
      if (from !== undefined) {
        options.onFallback?.({
          from,
          to: step.candidate,
          trigger: step.trigger,
          cloudFallback: step.cloudFallback,
        });
      }
      index = step.index;
      provider = options.open(step.candidate);
    }
  }
}

function streamedAfter(streamed: Streamed, delta: TurnDelta): Streamed {
  if (delta.type === "tool-call" || streamed === "tool-call") return "tool-call";
  if (delta.type === "progress" || delta.type === "done") return streamed;
  return "text";
}
