import type { Provider, TurnDelta } from "../../provider.ts";
import { ProviderHttpError } from "../../providers/errors.ts";
import { EndpointUnreachableError } from "../adapters/http.ts";
import { StreamTimeoutError } from "./timeouts.ts";
import { type HealthReading, healthReading } from "./types.ts";

export type BreakerState = "closed" | "open" | "half-open";

export type BreakerOutcome = "failure" | "saturated" | "ignored";

export interface BreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  saturationWindowMs?: number;
  now?: () => number;
}

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  lastSaturatedAt: number | null;
}

export type HalfOpenProbe = () => Promise<boolean>;

export class CircuitOpenError extends Error {
  readonly transient = true;

  constructor(
    readonly key: string,
    readonly retryAt: number,
  ) {
    super(`circuit for ${key} is open until ${new Date(retryAt).toISOString()}`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private current: BreakerState = "closed";
  private failures = 0;
  private openedAt: number | null = null;
  private lastSaturatedAt: number | null = null;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly saturationWindowMs: number;
  private readonly now: () => number;

  constructor(
    readonly key: string,
    options: BreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.saturationWindowMs = options.saturationWindowMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.current,
      consecutiveFailures: this.failures,
      openedAt: this.openedAt,
      lastSaturatedAt: this.lastSaturatedAt,
    };
  }

  async admit(probe: HalfOpenProbe): Promise<void> {
    if (this.current !== "open") return;
    const retryAt = (this.openedAt ?? 0) + this.cooldownMs;
    if (this.now() < retryAt) throw new CircuitOpenError(this.key, retryAt);
    this.current = "half-open";
    if (await probeQuietly(probe)) {
      this.close();
      return;
    }
    this.open();
    throw new CircuitOpenError(this.key, this.now() + this.cooldownMs);
  }

  succeeded(): void {
    this.close();
  }

  failed(kind: BreakerOutcome): void {
    if (kind === "saturated") this.lastSaturatedAt = this.now();
    if (kind !== "failure") return;
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.open();
  }

  async run<T>(
    call: () => Promise<T>,
    probe: HalfOpenProbe,
    classify: (cause: unknown) => BreakerOutcome = breakerOutcomeOf,
  ): Promise<T> {
    await this.admit(probe);
    try {
      const result = await call();
      this.succeeded();
      return result;
    } catch (cause) {
      this.failed(classify(cause));
      throw cause;
    }
  }

  recentlySaturated(): boolean {
    return (
      this.lastSaturatedAt !== null && this.now() - this.lastSaturatedAt < this.saturationWindowMs
    );
  }

  private open(): void {
    this.current = "open";
    this.openedAt = this.now();
  }

  private close(): void {
    this.current = "closed";
    this.failures = 0;
    this.openedAt = null;
  }
}

export class BreakerBoard {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly options: BreakerOptions = {}) {}

  for(node: string, model: string): CircuitBreaker {
    const key = `${node}/${model}`;
    const existing = this.breakers.get(key);
    if (existing !== undefined) return existing;
    const created = new CircuitBreaker(key, this.options);
    this.breakers.set(key, created);
    return created;
  }

  states(): Array<{ key: string } & BreakerSnapshot> {
    return [...this.breakers].map(([key, breaker]) => ({ key, ...breaker.snapshot() }));
  }
}

export function breakerOutcomeOf(
  cause: unknown,
  saturationStatuses: readonly number[] = [429, 503],
): BreakerOutcome {
  if (cause instanceof ProviderHttpError) {
    if (saturationStatuses.includes(cause.status)) return "saturated";
    return cause.status >= 500 || cause.status === 408 ? "failure" : "ignored";
  }
  if (cause instanceof StreamTimeoutError || cause instanceof EndpointUnreachableError) {
    return "failure";
  }
  return cause instanceof TypeError ? "failure" : "ignored";
}

export function guardedProvider(
  provider: Provider,
  breaker: CircuitBreaker,
  probe: HalfOpenProbe,
  classify: (cause: unknown) => BreakerOutcome = breakerOutcomeOf,
): Provider {
  return {
    name: provider.name,
    modelId: provider.modelId,
    capabilities: provider.capabilities,
    stream: async function* (request): AsyncGenerator<TurnDelta> {
      await breaker.admit(probe);
      try {
        yield* provider.stream(request);
        breaker.succeeded();
      } catch (cause) {
        breaker.failed(classify(cause));
        throw cause;
      }
    },
  };
}

export function effectiveHealth(probed: HealthReading, breaker: CircuitBreaker): HealthReading {
  const snapshot = breaker.snapshot();
  if (snapshot.state === "open") {
    return healthReading(
      "down",
      `circuit open after ${snapshot.consecutiveFailures} failures`,
      probed.checkedAt,
      probed.resident,
    );
  }
  if (probed.state === "up" && breaker.recentlySaturated()) {
    return healthReading(
      "saturated",
      "the server refused work recently",
      probed.checkedAt,
      probed.resident,
    );
  }
  return probed;
}

async function probeQuietly(probe: HalfOpenProbe): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}
