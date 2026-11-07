import { describe, expect, it } from "vitest";
import type { ProviderRegistration } from "../../inference/types.ts";
import { ProviderHttpError } from "../../providers/errors.ts";
import type { BenchBook, BenchOutcome, BenchTarget } from "../bench/book.ts";
import type {
  ModelInventory,
  ModelProbeRequest,
  ModelRow,
  ModelsFilter,
  ModelsReport,
} from "../discovery/inventory.ts";
import { ProviderAnswerBook } from "../health/answers.ts";
import { healthReading } from "../health/types.ts";
import { marketOf, memoryLicenseBook, stewardedInventory } from "./index.ts";
import { testSlate } from "./testing.ts";

const now = () => new Date("2026-11-05T12:00:00.000Z");
const checkedAt = "2026-11-05T12:00:00.000Z";

function registration(
  name: string,
  endpoint: string,
  overrides: Partial<ProviderRegistration> = {},
): ProviderRegistration {
  return {
    name,
    protocol: "chat-completions",
    endpoint,
    credential: { kind: "present", handle: { id: name, label: `${name.toUpperCase()}_API_KEY` } },
    models: [],
    openCatalog: false,
    enabled: true,
    ...overrides,
  };
}

const registrations: readonly ProviderRegistration[] = [
  registration("ollama", "http://localhost:11434/v1", { credential: { kind: "none" } }),
  registration("spark", "http://100.88.12.4:9931/v1", { credential: { kind: "none" } }),
  registration("openai", "https://api.openai.com/v1", {
    models: [
      {
        id: "gpt-5",
        origin: "declared",
        capabilities: { input: ["text", "image"], toolCalls: true, contextWindow: 400_000 },
      },
      { id: "unpriced-preview", origin: "reported" },
    ],
  }),
  registration("openrouter", "https://openrouter.ai/api/v1", {
    credential: { kind: "missing", expected: "OPENROUTER_API_KEY" },
    models: [{ id: "typesafe/jev-1.14", origin: "declared" }],
  }),
  registration("parked", "https://llm.example.com:8443/v1", { enabled: false }),
];

describe("marketOf", () => {
  it("lists only cloud providers, each in the inventory's columns", () => {
    const market = marketOf(registrations, now());
    expect(market.map(({ kind, port, auth, health }) => [kind, port, auth, health.state])).toEqual([
      ["openai", 443, "key", "unverified"],
      ["openrouter", 443, "key", "down"],
      ["parked", 8443, "key", "down"],
    ]);
    expect(market[0]).toMatchObject({
      protocol: "chat-completions",
      root: "https://api.openai.com/v1",
      source: "registry",
      fingerprint: null,
      version: null,
      health: {
        state: "unverified",
        detail: "listed by the inference registry; unverified until it answers a turn",
        checkedAt,
      },
    });
    expect(market[0]?.models.map(({ health }) => health.state)).toEqual([
      "unverified",
      "unverified",
    ]);
    expect(market[1]?.health.detail).toBe("no credential (OPENROUTER_API_KEY)");
    expect(market[2]?.health.detail).toBe("disabled in the inference registry");
  });

  it("says up only after the provider answered a turn, and down once it refused its key", () => {
    let clock = new Date("2026-11-05T12:01:00.000Z");
    const answers = new ProviderAnswerBook(() => clock);
    const openaiHealth = () => marketOf(registrations, now(), answers)[0]?.health;

    answers.answered("openai");
    expect(openaiHealth()).toEqual({
      state: "up",
      resident: null,
      detail: "answered a turn",
      checkedAt: "2026-11-05T12:01:00.000Z",
    });

    clock = new Date("2026-11-05T12:02:00.000Z");
    answers.failed("openai", new ProviderHttpError("openai", 401, "invalid api key"));
    expect(openaiHealth()).toEqual({
      state: "down",
      resident: null,
      detail: "refused its credential (401)",
      checkedAt: "2026-11-05T12:02:00.000Z",
    });
  });

  it("keeps an answer through failures that say nothing about the credential", () => {
    const answers = new ProviderAnswerBook(now);
    answers.answered("openai");
    answers.failed("openai", new ProviderHttpError("openai", 503, "busy"));
    answers.failed("openai", new TypeError("fetch failed"));
    answers.answered("parked");
    answers.answered("openrouter");

    expect(marketOf(registrations, now(), answers).map(({ health }) => health.state)).toEqual([
      "up",
      "down",
      "down",
    ]);
  });

  it("judges classes from declared capabilities, never from what no cloud provider measures, and prices from the price table", () => {
    const [openai, openrouter] = marketOf(registrations, now());
    const [gpt, unpriced] = openai?.models ?? [];
    expect(gpt).toMatchObject({
      id: "gpt-5",
      installed: false,
      loaded: false,
      contextAllocated: 400_000,
      classes: ["strong", "loop", "decide", "vision"],
      ineligible: [],
      license: null,
      licenseAcknowledgement: "unknown",
      cost: { source: "price_table", usdPerMillionInput: 1.25, usdPerMillionOutput: 10 },
    });
    expect(unpriced?.cost).toBeNull();
    expect(openrouter?.models[0]?.classes).toEqual(["decide"]);
  });
});

function row(id: string, license: string | null): ModelRow {
  const health = healthReading("up", "fixture", checkedAt);
  return {
    id,
    installed: true,
    loaded: false,
    contextAllocated: null,
    health,
    classes: [],
    ineligible: [],
    license,
    licenseAcknowledgement: license === null ? "unknown" : "required",
    cost: { source: "local_estimate", usdPerMillionInput: 0, usdPerMillionOutput: 0 },
  };
}

const sparkReport: ModelsReport = {
  generatedAt: checkedAt,
  nodes: [
    {
      node: "spark-ad4d",
      servers: [
        {
          kind: "llama-server",
          root: "http://100.88.12.4:9931",
          port: 9931,
          source: "advertised",
          auth: "none",
          fingerprint: "fp",
          version: "b12122",
          health: healthReading("up", "fixture", checkedAt),
          models: [
            row("qwen3.8-flash-next", null),
            row("laguna-xs-2.1", "OpenMDW-1.1"),
            row("mystery-7b", null),
          ],
        },
      ],
    },
  ],
};

function fakeInventory() {
  const filters: ModelsFilter[] = [];
  const probes: ModelProbeRequest[] = [];
  const inventory: Pick<ModelInventory, "list" | "probe"> = {
    list: async (filter = {}) => {
      filters.push(filter);
      return sparkReport;
    },
    probe: async (request) => {
      probes.push(request);
      return {
        root: request.endpoint,
        status: "unreachable",
        fingerprint: null,
        health: null,
        records: [],
        listedOnly: [],
        detail: "fixture",
      };
    },
  };
  return { inventory, filters, probes };
}

function recordingBenches() {
  const runs: BenchTarget[] = [];
  const outcome: BenchOutcome = { refused: "busy", error: "fixture" };
  const benches: BenchBook = {
    run: async (target) => {
      runs.push(target);
      return outcome;
    },
    last: async () => null,
  };
  return { benches, runs, outcome };
}

describe("stewardedInventory", () => {
  it("adds release dates, slate licenses and acknowledgements to every row", async () => {
    const licenses = memoryLicenseBook({ now });
    const steward = stewardedInventory(fakeInventory().inventory, {
      licenses,
      benches: recordingBenches().benches,
      slate: testSlate,
      now,
    });
    const before = await steward.list();
    expect(before.market).toBeUndefined();
    expect(before.nodes[0]?.servers[0]?.models.map(stewardFacts)).toEqual([
      ["qwen3.8-flash-next", "qwen-community-1.0", "required", "2026-08-24", null],
      ["laguna-xs-2.1", "OpenMDW-1.1", "not-required", null, null],
      ["mystery-7b", null, "unknown", null, null],
    ]);
    expect(
      await steward.acknowledge({
        endpoint: "http://100.88.12.4:9931",
        model: "qwen3.8-flash-next",
        license: "qwen-community-1.0",
      }),
    ).toEqual({
      model: "qwen3.8-flash-next",
      license: "qwen-community-1.0",
      acknowledgedAt: checkedAt,
    });
    const after = await steward.list();
    expect(after.nodes[0]?.servers[0]?.models[0]?.acknowledgedAt).toBe(checkedAt);
  });

  it("adds the market road unless one node is asked for", async () => {
    const { inventory, filters } = fakeInventory();
    const steward = stewardedInventory(inventory, {
      licenses: memoryLicenseBook(),
      benches: recordingBenches().benches,
      slate: testSlate,
      registrations: () => registrations,
      now,
    });
    const everything = await steward.list();
    expect(everything.market?.map(({ kind }) => kind)).toEqual(["openai", "openrouter", "parked"]);
    expect(everything.market?.[1]?.models[0]).toMatchObject({
      id: "typesafe/jev-1.14",
      license: "hosted",
      licenseAcknowledgement: "not-required",
      released: null,
      acknowledgedAt: null,
    });
    expect((await steward.list({ node: "spark-ad4d" })).market).toBeUndefined();
    expect(filters).toEqual([{}, { node: "spark-ad4d" }]);
  });

  it("reads market health from the answers it is given", async () => {
    const answers = new ProviderAnswerBook(now);
    answers.answered("openai");
    const steward = stewardedInventory(fakeInventory().inventory, {
      licenses: memoryLicenseBook(),
      benches: recordingBenches().benches,
      registrations: () => registrations,
      answers,
      now,
    });

    const { market } = await steward.list();
    expect(market?.map(({ kind, health }) => [kind, health.state])).toEqual([
      ["openai", "up"],
      ["openrouter", "down"],
      ["parked", "down"],
    ]);
  });

  it("names what inherit resolves to per class, unless one node is asked for", async () => {
    const steward = stewardedInventory(fakeInventory().inventory, {
      licenses: memoryLicenseBook(),
      benches: recordingBenches().benches,
      registrations: () => registrations,
      inherit: () => ({ provider: "openai", model: "gpt-5" }),
      now,
    });

    const { inherits } = await steward.list();
    expect(inherits?.strong).toEqual({ provider: "openai", model: "gpt-5" });
    expect(inherits?.vision).toEqual({ provider: "openai", model: "gpt-5" });
    expect(inherits?.loop).toEqual({ provider: "openai", model: "gpt-5" });
    expect(inherits?.decide).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      decider: "builtin",
    });
    expect((await steward.list({ node: "spark-ad4d" })).inherits).toBeUndefined();
  });

  it("leaves inherits out when the host names no inherit", async () => {
    const steward = stewardedInventory(fakeInventory().inventory, {
      licenses: memoryLicenseBook(),
      benches: recordingBenches().benches,
      registrations: () => registrations,
      now,
    });
    expect((await steward.list()).inherits).toBeUndefined();
  });

  it("passes probes to the inventory and benches to the bench book", async () => {
    const { inventory, probes } = fakeInventory();
    const { benches, runs, outcome } = recordingBenches();
    const steward = stewardedInventory(inventory, { licenses: memoryLicenseBook(), benches });
    await steward.probe({ endpoint: "http://127.0.0.1:11434" });
    const target = { endpoint: "http://127.0.0.1:11434", model: "qwen3.8:27b" };
    expect(await steward.bench(target)).toBe(outcome);
    expect(await steward.lastBench(target)).toBeNull();
    expect(probes).toEqual([{ endpoint: "http://127.0.0.1:11434" }]);
    expect(runs).toEqual([target]);
  });
});

function stewardFacts(model: {
  id: string;
  license: string | null;
  licenseAcknowledgement: string;
  released: string | null;
  acknowledgedAt: string | null;
}) {
  return [
    model.id,
    model.license,
    model.licenseAcknowledgement,
    model.released,
    model.acknowledgedAt,
  ];
}
