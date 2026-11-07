import type { Provider, ProviderRequest, TurnDelta } from "../../provider.ts";

export interface TimeoutPolicy {
  connectMs: number;
  firstTokenMs: number;
  idleMs: number;
  totalMs: number;
}

export interface LoadProfile {
  resident: boolean | null;
  parametersB: number | null;
}

export type TimeoutPhase = "first-token" | "idle" | "total";

export class StreamTimeoutError extends Error {
  readonly transient = true;

  constructor(
    readonly phase: TimeoutPhase,
    readonly afterMs: number,
  ) {
    super(`model stream timed out waiting for the ${phase} after ${afterMs} ms`);
    this.name = "StreamTimeoutError";
  }
}

export const connectTimeoutMs = 5_000;
export const warmFirstTokenMs = 30_000;
export const coldFirstTokenCeilingMs = 180_000;
export const coldFirstTokenMsPerBillion = 1_500;
export const idleTimeoutMs = 300_000;
export const generationBudgetMs = 900_000;

export function timeoutsFor(load: LoadProfile): TimeoutPolicy {
  const firstTokenMs = load.resident === true ? warmFirstTokenMs : coldFirstToken(load.parametersB);
  return {
    connectMs: connectTimeoutMs,
    firstTokenMs,
    idleMs: idleTimeoutMs,
    totalMs: firstTokenMs + generationBudgetMs,
  };
}

export function parametersInBillions(size: string | null): number | null {
  const match = size === null ? null : /^\s*(\d+(?:\.\d+)?)\s*([BM])/i.exec(size);
  if (match === null) return null;
  const amount = Number(match[1]);
  return match[2]?.toUpperCase() === "M" ? amount / 1000 : amount;
}

export function withStreamTimeouts(provider: Provider, policy: TimeoutPolicy): Provider {
  return {
    name: provider.name,
    modelId: provider.modelId,
    capabilities: provider.capabilities,
    stream: (request) => timedStream(provider, request, policy),
  };
}

function coldFirstToken(parametersB: number | null): number {
  if (parametersB === null) return coldFirstTokenCeilingMs;
  const scaled = parametersB * coldFirstTokenMsPerBillion;
  return Math.min(coldFirstTokenCeilingMs, Math.max(warmFirstTokenMs, scaled));
}

async function* timedStream(
  provider: Provider,
  request: ProviderRequest,
  policy: TimeoutPolicy,
): AsyncGenerator<TurnDelta> {
  const controller = new AbortController();
  const signal =
    request.signal === undefined
      ? controller.signal
      : AbortSignal.any([request.signal, controller.signal]);
  const iterator = provider.stream({ ...request, signal })[Symbol.asyncIterator]();
  const deadline = Date.now() + policy.totalMs;
  let waitingFor: TimeoutPhase = "first-token";
  try {
    while (true) {
      const budget = waitingFor === "first-token" ? policy.firstTokenMs : policy.idleMs;
      const remaining = deadline - Date.now();
      const phase = remaining < budget ? "total" : waitingFor;
      const next = await within(iterator.next(), Math.min(budget, remaining), () => {
        controller.abort();
        return new StreamTimeoutError(phase, phase === "total" ? policy.totalMs : budget);
      });
      if (next.done === true) return;
      waitingFor = "idle";
      yield next.value;
    }
  } finally {
    void iterator.return?.()?.catch(() => undefined);
  }
}

function within<T>(pending: Promise<T>, ms: number, timedOut: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timedOut()), Math.max(0, ms));
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
