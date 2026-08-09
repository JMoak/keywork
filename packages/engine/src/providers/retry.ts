import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { ProviderHttpError } from "./openai.ts";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RetryingProvider implements Provider {
  readonly name: string;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly inner: Provider,
    options: RetryOptions = {},
  ) {
    this.name = inner.name;
    this.attempts = options.attempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
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
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}

function isTransient(cause: unknown): boolean {
  if (cause instanceof ProviderHttpError) {
    return cause.status === 408 || cause.status === 429 || cause.status >= 500;
  }
  return cause instanceof TypeError;
}
