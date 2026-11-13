import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { campaignFixtureInput, fixtureCommand, fixtureUser } from "@keywork/campaigns/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { OpenAiCompatibleProvider } from "../providers/openai.ts";
import { RetryingProvider } from "../providers/retry.ts";
import { sseResponse } from "../providers/stream-fixtures.ts";
import type { FetchLike } from "../providers/transport.ts";
import { type MeteredCampaignProviderOptions, meteredCampaignProvider } from "./metering.ts";
import type { OpenRouterCampaignQuote } from "./pricing.ts";
import { CampaignStore } from "./store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

const request: ProviderRequest = {
  systemPrompt: "Private purpose",
  messages: [{ role: "user", parts: [{ type: "text", text: "Improve the report" }] }],
  tools: [],
};

describe("durable campaign model metering", () => {
  it("records context identity, reserves before dispatch, and settles reported actual cost", async () => {
    const world = await setup();
    let sent: Record<string, unknown> | undefined;
    const meter = world.meter(
      async (_url, init) => {
        expect(world.store.operation("call")?.state).toBe("dispatched");
        expect(world.store.spending(world.id).reservedMicros).toBeGreaterThan(0);
        sent = JSON.parse(String(init?.body));
        return completed();
      },
      {
        onOperation: (id, input, bound) => {
          expect(id).toBe("call");
          expect(world.store.operation(id)).toBeUndefined();
          expect(input.retry).toBe("never");
          expect(bound.inputTokens).toBeGreaterThan(1024);
        },
      },
    );
    const deltas = await collect(meter);
    expect(deltas.at(-1)?.type).toBe("done");
    expect(sent).toMatchObject({
      max_tokens: 64,
      provider: { only: ["openai"], allow_fallbacks: false },
    });
    expect(world.store.operation("call")).toMatchObject({
      state: "settled",
      response: { responseId: "gen-1", servedProvider: "OpenAI" },
      receipt: { state: "reported", costMicros: 100, providerRequestId: "gen-1" },
    });
    expect(world.store.spending(world.id)).toMatchObject({ settledMicros: 100, reservedMicros: 0 });
    expect(JSON.stringify(world.store.operation("call")?.request)).not.toContain("Private purpose");
  });

  it("never retries an ambiguous HTTP failure and preserves its identity after reopening", async () => {
    const world = await setup();
    let calls = 0;
    const meter = world.meter(async () => {
      calls++;
      return new Response("busy", { status: 503, headers: { "x-request-id": "http-lost" } });
    });
    await expect(collect(meter)).rejects.toThrow(/503/);
    expect(calls).toBe(1);
    const reopened = await CampaignStore.open(world.path, world.now);
    cleanups.push(async () => reopened.close());
    expect(reopened.operation("call")).toMatchObject({
      state: "unknown",
      receipt: { providerRequestId: "http-lost", state: "unknown" },
    });
    expect(reopened.spending(world.id)).toMatchObject({ unresolvedOperations: 1 });
    expect(reopened.spending(world.id).reservedMicros).toBeGreaterThan(0);
    await expect(collect(meter)).rejects.toThrow(/already dispatched/);
    expect(calls).toBe(1);
  });

  it.each([
    { choices: [{ delta: {} }] },
    { usage: { prompt_tokens: 10 } },
    { provider: "Other provider" },
    { model: "other/model" },
  ])("retains incomplete or mismatched outcomes without yielding done: %j", async (override) => {
    const world = await setup();
    const output: TurnDelta[] = [];
    await expect(
      (async () => {
        for await (const delta of world.meter(async () => completed(override)).stream(request))
          output.push(delta);
      })(),
    ).rejects.toThrow();
    expect(output.some((delta) => delta.type === "done")).toBe(false);
    expect(world.store.operation("call")?.state).toBe("unknown");
    expect(world.store.read(world.id)?.waitingReason).toBe("reconciliation");
  });

  it("retains known exposure above the reservation when identity cannot be trusted", async () => {
    const world = await setup();
    await expect(
      collect(
        world.meter(async () =>
          completed({
            model: "other",
            usage: { prompt_tokens: 10, completion_tokens: 3, cost: 2 },
          }),
        ),
      ),
    ).rejects.toThrow(/identity/);
    expect(world.store.operation("call")).toMatchObject({
      state: "unknown",
      receipt: { costMicros: 2_000_000 },
    });
    expect(world.store.spending(world.id).reservedMicros).toBe(2_000_000);
  });

  it("keeps token-rate estimates reserved and preserves explicit zero actual cost", async () => {
    const world = await setup();
    await collect(
      world.meter(async () => completed({ usage: { prompt_tokens: 10, completion_tokens: 3 } })),
    );
    expect(world.store.operation("call")).toMatchObject({
      state: "settled",
      receipt: { state: "estimated", costMicros: 44 },
    });
    expect(world.store.spending(world.id).reservedMicros).toBeGreaterThan(44);
    const zero = world.meter(
      async () => completed({ usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } }),
      { operationId: () => "zero" },
    );
    await collect(zero);
    expect(world.store.operation("zero")?.receipt).toMatchObject({
      state: "reported",
      costMicros: 0,
    });
  });

  it("releases an undispatched reservation when cancellation wins admission", async () => {
    const world = await setup();
    let called = false;
    world.store.subscribe((event) => {
      if (event.kind !== "usage.reserved") return;
      const current = world.store.read(world.id);
      if (current === undefined) throw new Error("missing fixture");
      world.store.apply(
        world.id,
        fixtureCommand(current, { type: "cancel", reason: "stop" }),
        fixtureUser,
      );
    });
    await expect(
      collect(
        world.meter(async () => {
          called = true;
          return completed();
        }),
      ),
    ).rejects.toThrow(/dispatch stopped/);
    expect(called).toBe(false);
    expect(world.store.operation("call")?.state).toBe("released");
    expect(world.store.spending(world.id).reservedMicros).toBe(0);
  });

  it("retains a dispatched request when its consumer closes the stream", async () => {
    const world = await setup();
    const iterator = world
      .meter(async () => completed())
      .stream(request)
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("text");
    await iterator.return?.();
    expect(world.store.operation("call")).toMatchObject({
      state: "unknown",
      response: { responseId: "gen-1" },
    });
  });

  it("rejects revoked authority after context preparation before reserving", async () => {
    const world = await setup();
    let authorized = true;
    let calls = 0;
    await expect(
      collect(
        world.meter(
          async () => {
            calls++;
            return completed();
          },
          {
            authorize: () => authorized,
            onOperation: () => {
              authorized = false;
            },
          },
        ),
      ),
    ).rejects.toThrow(/authority was revoked/);
    expect(calls).toBe(0);
    expect(world.store.operations(world.id)).toHaveLength(0);
  });

  it.each([
    { event: "usage.reserved", state: "released", retained: false },
    { event: "operation.dispatched", state: "unknown", retained: true },
  ])("checks authority after durable $event observers", async ({ event, state, retained }) => {
    const world = await setup();
    let authorized = true;
    let calls = 0;
    world.store.subscribe((change) => {
      if (change.kind === event) authorized = false;
    });
    await expect(
      collect(
        world.meter(
          async () => {
            calls++;
            return completed();
          },
          { authorize: () => authorized },
        ),
      ),
    ).rejects.toThrow(/authority was revoked/);
    expect(calls).toBe(0);
    expect(world.store.operation("call")?.state).toBe(state);
    expect(world.store.spending(world.id).reservedMicros > 0).toBe(retained);
  });

  it("records an over-bound actual charge before refusing artifact completion", async () => {
    const world = await setup();
    await expect(
      collect(
        world.meter(async () =>
          completed({ usage: { prompt_tokens: 10, completion_tokens: 3, cost: 2 } }),
        ),
      ),
    ).rejects.toThrow(/exceeded/);
    expect(world.store.operation("call")?.receipt).toMatchObject({
      state: "reported",
      costMicros: 2_000_000,
    });
    expect(world.store.spending(world.id)).toMatchObject({
      settledMicros: 2_000_000,
      remainingMicros: 0,
    });
  });

  it("refuses unaffordable requests and stale quotes before dispatch", async () => {
    const world = await setup(1000);
    let calls = 0;
    const send: FetchLike = async () => {
      calls++;
      return completed();
    };
    await expect(collect(world.meter(send))).rejects.toThrow(/budget/);
    await expect(
      collect(world.meter(send, { quote: { ...quoteFixture(), expiresAt: 1000 } })),
    ).rejects.toThrow(/expired/);
    await expect(
      collect(world.meter(send, { onOperation: () => world.advance(60_001) })),
    ).rejects.toThrow(/expired/);
    expect(calls).toBe(0);
    expect(world.store.operations(world.id)).toHaveLength(0);
  });
});

async function setup(budget = 1_000_000) {
  const directory = await mkdtemp(join(tmpdir(), "keywork-campaign-meter-"));
  const path = join(directory, "campaigns.db");
  let clock = 1000;
  const now = () => clock;
  const store = await CampaignStore.open(path, now);
  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const input = campaignFixtureInput();
  input.model = {
    providerId: "openrouter",
    modelId: "openai/gpt-4.1",
    connectionId: null,
    effort: null,
  };
  input.persistence.spendLimitMicros = Math.min(input.persistence.spendLimitMicros, budget);
  input.budget = {
    currency: "USD",
    limitMicros: budget,
    evaluationReserveMicros: 0,
    deliveryReserveMicros: 0,
  };
  store.create(input);
  for (const type of ["ready", "start"] as const) {
    const current = store.read(input.id);
    if (current === undefined) throw new Error("missing fixture");
    store.apply(input.id, fixtureCommand(current, { type, reason: "fixture" }), fixtureUser);
  }
  const lease = store.claim(input.id, "runner", 300_000);
  if (lease === undefined) throw new Error("missing fixture lease");
  return {
    store,
    path,
    now,
    id: input.id,
    advance: (ms: number) => {
      clock += ms;
    },
    meter: (fetchFn: FetchLike, overrides: Partial<MeteredCampaignProviderOptions> = {}) =>
      meteredCampaignProvider({
        provider: new RetryingProvider(
          new OpenAiCompatibleProvider({
            name: "openrouter",
            model: "openai/gpt-4.1",
            baseUrl: "https://openrouter.ai/api/v1",
            fetchFn,
          }),
        ),
        store,
        lease: () => lease,
        campaignId: input.id,
        attemptId: null,
        stage: "building",
        quote: quoteFixture(),
        maxOutputTokens: 64,
        now,
        operationId: () => "call",
        ...overrides,
      }),
  };
}

function quoteFixture(): OpenRouterCampaignQuote {
  return {
    modelId: "openai/gpt-4.1",
    providerTag: "openai",
    providerName: "OpenAI",
    sourceUrl: "https://openrouter.ai/api/v1/models/openai/gpt-4.1/endpoints",
    quotedAt: 1000,
    expiresAt: 61000,
    contextTokens: 100_000,
    maxOutputTokens: 32768,
    ratesMicrosPerToken: { prompt: 2, completion: 8, cacheRead: 0.5, cacheWrite: 2 },
    requestMicros: 0,
    routing: { only: ["openai"], maxPrice: { prompt: 2, completion: 8, request: 0 } },
    provenance: ["fixture"],
  };
}

function completed(override: Record<string, unknown> = {}) {
  return sseResponse([
    JSON.stringify({
      id: "gen-1",
      model: "openai/gpt-4.1",
      provider: "OpenAI",
      choices: [{ delta: { content: "Candidate" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0001 },
      ...override,
    }),
    "[DONE]",
  ]);
}

async function collect(provider: Provider): Promise<TurnDelta[]> {
  const output: TurnDelta[] = [];
  for await (const delta of provider.stream(request)) output.push(delta);
  return output;
}
