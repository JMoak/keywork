import { describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { ProviderEmptyResponseError, ProviderHttpError } from "./errors.ts";
import { RetryingProvider, type RetryOptions } from "./retry.ts";

const request: ProviderRequest = {
  systemPrompt: "",
  messages: [textMessage("user", "hi")],
  tools: [],
};

const goodTurn: TurnDelta[] = [
  { type: "text", text: "ok" },
  { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
];

function providerFailingTimes(failures: number, error: () => Error): Provider {
  let remaining = failures;
  return {
    name: "flaky",
    async *stream() {
      if (remaining > 0) {
        remaining -= 1;
        throw error();
      }
      yield* goodTurn;
    },
  };
}

async function collect(iterable: AsyncIterable<TurnDelta>): Promise<TurnDelta[]> {
  const deltas: TurnDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

const instantSleep = async () => {};

function recordingDelays(options: RetryOptions = {}): { delays: number[]; options: RetryOptions } {
  const delays: number[] = [];
  return {
    delays,
    options: {
      attempts: 3,
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
      ...options,
    },
  };
}

const throttled = () => new ProviderHttpError("flaky", 429, "slow down");

describe("RetryingProvider", () => {
  it("retries transient failures with exponential backoff and then succeeds", async () => {
    const { delays, options } = recordingDelays({ random: () => 1 });
    const provider = new RetryingProvider(providerFailingTimes(2, throttled), options);

    const deltas = await collect(provider.stream(request));

    expect(deltas).toEqual(goodTurn);
    expect(delays).toEqual([100, 200]);
  });

  it("jitters each delay between half and the full exponential step", async () => {
    const low = recordingDelays({ random: () => 0 });
    await collect(
      new RetryingProvider(providerFailingTimes(2, throttled), low.options).stream(request),
    );
    expect(low.delays).toEqual([50, 100]);

    const mid = recordingDelays({ random: () => 0.5 });
    await collect(
      new RetryingProvider(providerFailingTimes(2, throttled), mid.options).stream(request),
    );
    expect(mid.delays).toEqual([75, 150]);
  });

  it("caps every delay at the ceiling", async () => {
    const { delays, options } = recordingDelays({ attempts: 4, maxDelayMs: 150, random: () => 1 });
    await collect(
      new RetryingProvider(providerFailingTimes(3, throttled), options).stream(request),
    );
    expect(delays).toEqual([100, 150, 150]);
  });

  it("honors Retry-After in seconds over its own backoff, still under the ceiling", async () => {
    const { delays, options } = recordingDelays({ maxDelayMs: 5_000, random: () => 1 });
    const advised = () => new ProviderHttpError("flaky", 429, "slow down", "3");
    await collect(new RetryingProvider(providerFailingTimes(1, advised), options).stream(request));
    expect(delays).toEqual([3_000]);

    const farAhead = () => new ProviderHttpError("flaky", 503, "busy", "60");
    const capped = recordingDelays({ maxDelayMs: 5_000 });
    await collect(
      new RetryingProvider(providerFailingTimes(1, farAhead), capped.options).stream(request),
    );
    expect(capped.delays).toEqual([5_000]);
  });

  it("honors an HTTP-date Retry-After measured against the injected clock", async () => {
    const now = Date.parse("2026-08-22T10:00:00Z");
    const at = () => new ProviderHttpError("flaky", 429, "later", "Sat, 22 Aug 2026 10:00:02 GMT");
    const { delays, options } = recordingDelays({ now: () => now, random: () => 1 });
    await collect(new RetryingProvider(providerFailingTimes(1, at), options).stream(request));
    expect(delays).toEqual([2_000]);

    const past = () =>
      new ProviderHttpError("flaky", 429, "later", "Sat, 22 Aug 2026 09:59:00 GMT");
    const immediate = recordingDelays({ now: () => now });
    await collect(
      new RetryingProvider(providerFailingTimes(1, past), immediate.options).stream(request),
    );
    expect(immediate.delays).toEqual([0]);
  });

  it("falls back to backoff when Retry-After is unparseable", async () => {
    const junk = () => new ProviderHttpError("flaky", 429, "later", "soon-ish");
    const { delays, options } = recordingDelays({ random: () => 1 });
    await collect(new RetryingProvider(providerFailingTimes(1, junk), options).stream(request));
    expect(delays).toEqual([100]);
  });

  it("gives up after the configured attempts", async () => {
    const provider = new RetryingProvider(
      providerFailingTimes(5, () => new ProviderHttpError("flaky", 503, "down")),
      { attempts: 3, sleep: instantSleep },
    );

    await expect(collect(provider.stream(request))).rejects.toThrow(/503/);
  });

  it("does not retry non-transient failures", async () => {
    let calls = 0;
    const provider = new RetryingProvider(
      {
        name: "bad-request",
        // biome-ignore lint/correctness/useYield: failure path throws before yielding
        async *stream() {
          calls += 1;
          throw new ProviderHttpError("bad-request", 400, "malformed");
        },
      },
      { attempts: 3, sleep: instantSleep },
    );

    await expect(collect(provider.stream(request))).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it("never retries after deltas were already delivered", async () => {
    let calls = 0;
    const provider = new RetryingProvider(
      {
        name: "mid-stream",
        async *stream() {
          calls += 1;
          yield { type: "text", text: "partial" } as TurnDelta;
          throw new ProviderHttpError("mid-stream", 500, "dropped");
        },
      },
      { attempts: 3, sleep: instantSleep },
    );

    await expect(collect(provider.stream(request))).rejects.toThrow(/dropped/);
    expect(calls).toBe(1);
  });

  it("retries errors that declare themselves transient", async () => {
    const provider = new RetryingProvider(
      providerFailingTimes(1, () => Object.assign(new Error("throttled"), { transient: true })),
      { attempts: 2, sleep: instantSleep },
    );

    expect(await collect(provider.stream(request))).toEqual(goodTurn);
  });

  it("retries an empty response body", async () => {
    const provider = new RetryingProvider(
      providerFailingTimes(1, () => new ProviderEmptyResponseError("flaky")),
      { attempts: 2, sleep: instantSleep },
    );

    expect(await collect(provider.stream(request))).toEqual(goodTurn);
  });

  it("does not retry errors that declare themselves non-transient", async () => {
    const provider = new RetryingProvider(
      providerFailingTimes(1, () => Object.assign(new Error("invalid"), { transient: false })),
      { attempts: 3, sleep: instantSleep },
    );

    await expect(collect(provider.stream(request))).rejects.toThrow(/invalid/);
  });

  it("retries plain network errors", async () => {
    const provider = new RetryingProvider(
      providerFailingTimes(1, () => new TypeError("fetch failed")),
      { attempts: 2, sleep: instantSleep },
    );

    expect(await collect(provider.stream(request))).toEqual(goodTurn);
  });

  it("retries TypeErrors whose cause is a network failure", async () => {
    const provider = new RetryingProvider(
      providerFailingTimes(
        1,
        () =>
          new TypeError("request failed", {
            cause: Object.assign(new Error("write"), { code: "ECONNRESET" }),
          }),
      ),
      { attempts: 2, sleep: instantSleep },
    );

    expect(await collect(provider.stream(request))).toEqual(goodTurn);
  });

  it("does not retry programmer TypeErrors", async () => {
    let calls = 0;
    const provider = new RetryingProvider(
      {
        name: "buggy",
        // biome-ignore lint/correctness/useYield: failure path throws before yielding
        async *stream() {
          calls += 1;
          throw new TypeError("Cannot read properties of undefined (reading 'delta')");
        },
      },
      { attempts: 3, sleep: instantSleep },
    );

    await expect(collect(provider.stream(request))).rejects.toThrow(/Cannot read properties/);
    expect(calls).toBe(1);
  });

  it("aborts the backoff sleep promptly when the signal fires", async () => {
    const controller = new AbortController();
    const provider = new RetryingProvider(providerFailingTimes(5, throttled), {
      attempts: 3,
      baseDelayMs: 60_000,
      maxDelayMs: 60_000,
    });
    const startedAt = Date.now();
    const outcome = collect(provider.stream({ ...request, signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);

    await expect(outcome).rejects.toThrow(/429/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
