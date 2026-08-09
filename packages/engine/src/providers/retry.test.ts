import { describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { ProviderHttpError } from "./openai.ts";
import { RetryingProvider } from "./retry.ts";

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

describe("RetryingProvider", () => {
  it("retries transient failures with exponential backoff and then succeeds", async () => {
    const delays: number[] = [];
    const provider = new RetryingProvider(
      providerFailingTimes(2, () => new ProviderHttpError("flaky", 429, "slow down")),
      {
        attempts: 3,
        baseDelayMs: 100,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    const deltas = await collect(provider.stream(request));

    expect(deltas).toEqual(goodTurn);
    expect(delays).toEqual([100, 200]);
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

  it("retries plain network errors", async () => {
    const provider = new RetryingProvider(
      providerFailingTimes(1, () => new TypeError("fetch failed")),
      { attempts: 2, sleep: instantSleep },
    );

    expect(await collect(provider.stream(request))).toEqual(goodTurn);
  });
});
