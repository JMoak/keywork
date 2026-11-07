import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider, ProviderRequest, TurnDelta } from "../../provider.ts";
import { ProviderHttpError } from "../../providers/errors.ts";
import {
  BreakerBoard,
  breakerOutcomeOf,
  CircuitBreaker,
  CircuitOpenError,
  effectiveHealth,
  guardedProvider,
  healthReading,
  parametersInBillions,
  StreamTimeoutError,
  timeoutsFor,
  withStreamTimeouts,
} from "./index.ts";

const request: ProviderRequest = { systemPrompt: "", messages: [], tools: [] };

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const serverError = () => new ProviderHttpError("ollama", 500, "boom");

describe("CircuitBreaker", () => {
  it("opens after consecutive failures and refuses until the cooldown passes", async () => {
    const time = clock();
    const breaker = new CircuitBreaker("spark/nimble", {
      failureThreshold: 2,
      cooldownMs: 1000,
      now: time.now,
    });
    const probe = vi.fn(async () => true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(breaker.run(() => Promise.reject(serverError()), probe)).rejects.toThrow(/500/);
    }
    expect(breaker.snapshot().state).toBe("open");
    await expect(breaker.run(async () => "ok", probe)).rejects.toThrow(CircuitOpenError);
    expect(probe).not.toHaveBeenCalled();
  });

  it("closes through a successful one-token half-open probe", async () => {
    const time = clock();
    const breaker = new CircuitBreaker("k", {
      failureThreshold: 1,
      cooldownMs: 1000,
      now: time.now,
    });
    await expect(
      breaker.run(
        () => Promise.reject(serverError()),
        async () => true,
      ),
    ).rejects.toThrow();
    time.advance(1000);
    const probe = vi.fn(async () => true);
    expect(await breaker.run(async () => "served", probe)).toBe("served");
    expect(probe).toHaveBeenCalledOnce();
    expect(breaker.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("reopens when the half-open probe fails or throws", async () => {
    const time = clock();
    const breaker = new CircuitBreaker("k", {
      failureThreshold: 1,
      cooldownMs: 1000,
      now: time.now,
    });
    await expect(
      breaker.run(
        () => Promise.reject(serverError()),
        async () => true,
      ),
    ).rejects.toThrow();
    time.advance(1000);
    await expect(
      breaker.run(
        async () => "never",
        async () => {
          throw new TypeError("fetch failed");
        },
      ),
    ).rejects.toThrow(CircuitOpenError);
    expect(breaker.snapshot()).toMatchObject({ state: "open", openedAt: time.now() });
  });

  it("treats saturation as saturation, not failure", async () => {
    const time = clock();
    const breaker = new CircuitBreaker("k", { failureThreshold: 1, now: time.now });
    const saturated = new ProviderHttpError("ollama", 503, "server busy");
    await expect(
      breaker.run(
        () => Promise.reject(saturated),
        async () => true,
      ),
    ).rejects.toThrow();
    expect(breaker.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    expect(breaker.recentlySaturated()).toBe(true);
    const up = healthReading("up", "ready", "2026-11-05T12:00:00.000Z", true);
    expect(effectiveHealth(up, breaker).state).toBe("saturated");
    time.advance(30_000);
    expect(effectiveHealth(up, breaker).state).toBe("up");
  });

  it("reports an open circuit as down", async () => {
    const breaker = new CircuitBreaker("k", { failureThreshold: 1 });
    await expect(
      breaker.run(
        () => Promise.reject(serverError()),
        async () => true,
      ),
    ).rejects.toThrow();
    expect(effectiveHealth(healthReading("up", "ready", "t"), breaker)).toMatchObject({
      state: "down",
      detail: "circuit open after 1 failures",
    });
  });

  it("keys breakers per node and model", () => {
    const board = new BreakerBoard();
    expect(board.for("spark-ad4d", "nimble")).toBe(board.for("spark-ad4d", "nimble"));
    expect(board.for("spark-ad4d", "nimble")).not.toBe(board.for("moak-main", "nimble"));
    expect(board.states().map((state) => state.key)).toEqual([
      "spark-ad4d/nimble",
      "moak-main/nimble",
    ]);
  });

  it("classifies failures", () => {
    expect(breakerOutcomeOf(new ProviderHttpError("p", 503, ""))).toBe("saturated");
    expect(breakerOutcomeOf(new ProviderHttpError("p", 429, ""))).toBe("saturated");
    expect(breakerOutcomeOf(new ProviderHttpError("p", 502, ""))).toBe("failure");
    expect(breakerOutcomeOf(new ProviderHttpError("p", 404, "model not found"))).toBe("ignored");
    expect(breakerOutcomeOf(new StreamTimeoutError("first-token", 1))).toBe("failure");
    expect(breakerOutcomeOf(new ProviderHttpError("p", 503, ""), [])).toBe("failure");
  });

  it("guards a provider stream and counts a mid-stream failure", async () => {
    const breaker = new CircuitBreaker("k", { failureThreshold: 1 });
    const failing: Provider = {
      name: "p",
      stream: async function* () {
        yield { type: "text", text: "partial" };
        throw serverError();
      },
    };
    const guarded = guardedProvider(failing, breaker, async () => false);
    await expect(collect(guarded.stream(request))).rejects.toThrow(/500/);
    expect(breaker.snapshot().state).toBe("open");
    await expect(collect(guarded.stream(request))).rejects.toThrow(CircuitOpenError);
  });
});

describe("timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a cold load up to 180 s, scaled by model size", () => {
    expect(timeoutsFor({ resident: true, parametersB: 120 }).firstTokenMs).toBe(30_000);
    expect(timeoutsFor({ resident: false, parametersB: 120 }).firstTokenMs).toBe(180_000);
    expect(timeoutsFor({ resident: false, parametersB: 27.8 }).firstTokenMs).toBe(41_700);
    expect(timeoutsFor({ resident: false, parametersB: 9 }).firstTokenMs).toBe(30_000);
    expect(timeoutsFor({ resident: null, parametersB: null })).toEqual({
      connectMs: 5_000,
      firstTokenMs: 180_000,
      idleMs: 300_000,
      totalMs: 1_080_000,
    });
  });

  it("reads parameter sizes", () => {
    expect(parametersInBillions("27.8B")).toBe(27.8);
    expect(parametersInBillions("800M")).toBe(0.8);
    expect(parametersInBillions(null)).toBeNull();
    expect(parametersInBillions("unknown")).toBeNull();
  });

  it("aborts a stream that never produces a first token", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const silent: Provider = {
      name: "p",
      stream: async function* (inner) {
        await new Promise<void>((_, reject) =>
          inner.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }),
        );
        yield { type: "text", text: "never" };
      },
    };
    const timed = withStreamTimeouts(silent, {
      connectMs: 1,
      firstTokenMs: 100,
      idleMs: 50,
      totalMs: 1000,
    });
    const outcome = collect(timed.stream(request)).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(100);
    const cause = await outcome;
    expect(cause).toBeInstanceOf(StreamTimeoutError);
    expect(cause).toMatchObject({ phase: "first-token", afterMs: 100 });
    expect(aborted).toBe(true);
  });

  it("aborts a stream that goes idle between tokens", async () => {
    vi.useFakeTimers();
    const stalls: Provider = {
      name: "p",
      stream: async function* () {
        yield { type: "text", text: "first" };
        await new Promise(() => undefined);
      },
    };
    const timed = withStreamTimeouts(stalls, {
      connectMs: 1,
      firstTokenMs: 100,
      idleMs: 50,
      totalMs: 1000,
    });
    const seen: TurnDelta[] = [];
    const outcome = (async () => {
      for await (const delta of timed.stream(request)) seen.push(delta);
    })().catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(60);
    expect(await outcome).toMatchObject({ phase: "idle" });
    expect(seen).toEqual([{ type: "text", text: "first" }]);
  });

  it("caps the whole turn at the total budget", async () => {
    vi.useFakeTimers();
    const drip: Provider = {
      name: "p",
      stream: async function* () {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          yield { type: "text", text: "." };
        }
      },
    };
    const timed = withStreamTimeouts(drip, {
      connectMs: 1,
      firstTokenMs: 100,
      idleMs: 50,
      totalMs: 200,
    });
    const outcome = collect(timed.stream(request)).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(250);
    expect(await outcome).toMatchObject({ phase: "total", afterMs: 200 });
  });

  it("passes a prompt stream through untouched", async () => {
    const quick: Provider = {
      name: "p",
      stream: async function* () {
        yield { type: "text", text: "hi" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const timed = withStreamTimeouts(quick, timeoutsFor({ resident: true, parametersB: 9 }));
    expect(await collect(timed.stream(request))).toEqual([
      { type: "text", text: "hi" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  });
});

async function collect(stream: AsyncIterable<TurnDelta>): Promise<TurnDelta[]> {
  const deltas: TurnDelta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}
