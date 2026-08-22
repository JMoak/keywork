import type { ModelCapabilities } from "../capabilities.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { ProviderHttpError } from "./errors.ts";

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: Sleep;
  now?: () => number;
  random?: () => number;
}

export class RetryingProvider implements Provider {
  readonly name: string;
  readonly modelId: string | undefined;
  readonly capabilities: ModelCapabilities | undefined;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly inner: Provider,
    options: RetryOptions = {},
  ) {
    this.name = inner.name;
    this.modelId = inner.modelId;
    this.capabilities = inner.capabilities;
    this.attempts = options.attempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    for (let attempt = 1; ; attempt += 1) {
      let yieldedAny = false;
      try {
        for await (const delta of this.inner.stream(request)) {
          yieldedAny = true;
          yield delta;
        }
        return;
      } catch (cause) {
        const retryable =
          !yieldedAny &&
          attempt < this.attempts &&
          request.signal?.aborted !== true &&
          isTransient(cause);
        if (!retryable) throw cause;
        await this.sleep(this.delayBefore(attempt, cause), request.signal);
        if (request.signal?.aborted === true) throw cause;
      }
    }
  }

  private delayBefore(attempt: number, cause: unknown): number {
    const exponential = this.baseDelayMs * 2 ** (attempt - 1);
    const jittered = exponential / 2 + this.random() * (exponential / 2);
    return Math.min(this.maxDelayMs, retryAfterMs(cause, this.now()) ?? jittered);
  }
}

function retryAfterMs(cause: unknown, now: number): number | undefined {
  if (!(cause instanceof ProviderHttpError) || cause.retryAfter === undefined) return undefined;
  const header = cause.retryAfter.trim();
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish);
  });
}

function isTransient(cause: unknown): boolean {
  if (cause instanceof ProviderHttpError) {
    return cause.status === 408 || cause.status === 429 || cause.status >= 500;
  }
  return declaresTransience(cause) || isNetworkFailure(cause);
}

function declaresTransience(cause: unknown): boolean {
  return cause instanceof Error && (cause as { transient?: unknown }).transient === true;
}

const networkFailurePattern =
  /fetch failed|network|socket|connection|connect econn|econnreset|econnrefused|etimedout|eai_again|epipe|terminated|dns/i;

function isNetworkFailure(cause: unknown): boolean {
  if (!(cause instanceof TypeError)) return false;
  if (networkFailurePattern.test(cause.message)) return true;
  const inner = cause.cause;
  return (
    inner instanceof Error && networkFailurePattern.test(`${inner.message} ${describeCode(inner)}`)
  );
}

function describeCode(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}
