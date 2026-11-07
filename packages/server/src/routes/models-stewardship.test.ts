import { MockProvider, type ProviderRegistration } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { benchBook } from "../../../engine/src/models/bench/index.ts";
import {
  memoryLicenseBook,
  stewardedInventory,
} from "../../../engine/src/models/licenses/index.ts";
import { testSlate } from "../../../engine/src/models/licenses/testing.ts";
import { fixtureDocument } from "../contract-fixtures.ts";
import { EventLog } from "../events.ts";
import { operationOf } from "../openapi.ts";
import { memorySessionHost } from "../testing.ts";
import type { RouteHandler } from "./family.ts";
import {
  licenseRequestOf,
  type ModelBenchOutcome,
  type ModelLicenseRequest,
  type ModelsPort,
  type ModelTarget,
  modelFamilyFor,
  modelRoutes,
  modelStewardshipRoutes,
  modelTargetOf,
} from "./models.ts";

const origin = "http://127.0.0.1:4770";
const spark = "http://100.88.12.4:9931";

const emptyReport = { generatedAt: "2026-11-05T12:00:00.000Z", nodes: [] };

interface ListedModels {
  nodes: { servers: { models: object[] }[] }[];
}

function inventoryOnly(): ModelsPort {
  return { list: async () => emptyReport, probe: async () => ({}) };
}

function recordingPort(outcome: ModelBenchOutcome) {
  const acknowledged: ModelLicenseRequest[] = [];
  const benched: ModelTarget[] = [];
  const read: ModelTarget[] = [];
  const port: ModelsPort = {
    ...inventoryOnly(),
    acknowledge: async (request) => {
      acknowledged.push(request);
      return { model: request.model, license: request.license, acknowledgedAt: "now" };
    },
    bench: async (target) => {
      benched.push(target);
      return outcome;
    },
    lastBench: async (target) => {
      read.push(target);
      return null;
    },
  };
  return { port, acknowledged, benched, read };
}

function handlers(port: ModelsPort | undefined) {
  const log = new EventLog();
  return modelFamilyFor(() => port).handlers({
    host: memorySessionHost({ log, provider: new MockProvider([]) }),
    log,
    streams: { add: () => () => undefined },
    describe: fixtureDocument,
  });
}

async function call(
  handler: RouteHandler,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await handler(
    new Request(`${origin}${path}`, {
      method,
      ...(body !== undefined && {
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    }),
    {},
  );
  return { status: response.status, body: await response.json() };
}

const flash = { endpoint: spark, model: "qwen3.8-flash-next" };
const flashLicense = { ...flash, license: "qwen-community-1.0" };
const benchQuery = `/models/bench?${new URLSearchParams(flash)}`;

describe("the model stewardship routes", () => {
  it("declare authenticated acknowledgement, bench and last-bench operations in the models family", () => {
    expect(
      modelStewardshipRoutes.map((route) => [route.method, route.path, route.operationId]),
    ).toEqual([
      ["POST", "/models/acknowledgements", "acknowledgeModelLicense"],
      ["POST", "/models/bench", "benchModel"],
      ["GET", "/models/bench", "readModelBench"],
    ]);
    expect(modelStewardshipRoutes.every((route) => route.authenticated)).toBe(true);
    expect(modelStewardshipRoutes.map((route) => operationOf(route).requestBody?.required)).toEqual(
      [true, true, undefined],
    );
    expect(modelFamilyFor(() => undefined).routes).toEqual([
      ...modelRoutes,
      ...modelStewardshipRoutes,
    ]);
    const document = fixtureDocument();
    expect(document.paths["/models/acknowledgements"]?.post?.operationId).toBe(
      "acknowledgeModelLicense",
    );
    expect(document.paths["/models/bench"]?.get?.operationId).toBe("readModelBench");
  });

  it("answer 503 when the host has no inventory or the inventory keeps no stewardship", async () => {
    for (const port of [undefined, inventoryOnly()]) {
      const h = handlers(port);
      expect(
        (await call(h.acknowledgeModelLicense, "POST", "/models/acknowledgements", flashLicense))
          .status,
      ).toBe(503);
      expect((await call(h.benchModel, "POST", "/models/bench", flash)).status).toBe(503);
      expect((await call(h.readModelBench, "GET", benchQuery)).status).toBe(503);
    }
  });

  it("acknowledge a license with the fields it names", async () => {
    const { port, acknowledged } = recordingPort({ report: {} });
    const answer = await call(
      handlers(port).acknowledgeModelLicense,
      "POST",
      "/models/acknowledgements",
      { ...flashLicense, extra: true },
    );
    expect(answer).toEqual({
      status: 200,
      body: { model: "qwen3.8-flash-next", license: "qwen-community-1.0", acknowledgedAt: "now" },
    });
    expect(acknowledged).toEqual([flashLicense]);
  });

  it("refuse malformed acknowledgements, benches and queries with 400 and never reach the port", async () => {
    const { port, acknowledged, benched, read } = recordingPort({ report: {} });
    const h = handlers(port);
    for (const body of [
      {},
      { ...flashLicense, license: " " },
      { ...flashLicense, endpoint: "file:///etc/passwd" },
      { ...flashLicense, model: 7 },
      "not json",
    ]) {
      expect(
        (await call(h.acknowledgeModelLicense, "POST", "/models/acknowledgements", body)).status,
      ).toBe(400);
    }
    for (const body of [{}, { endpoint: spark }, { ...flash, endpoint: "spark" }]) {
      expect((await call(h.benchModel, "POST", "/models/bench", body)).status).toBe(400);
    }
    for (const query of ["", `?endpoint=${spark}`, "?endpoint=nope&model=x"]) {
      expect((await call(h.readModelBench, "GET", `/models/bench${query}`)).status).toBe(400);
    }
    expect([acknowledged, benched, read]).toEqual([[], [], []]);
  });

  it("answer a finished bench with its report and each refusal with its status", async () => {
    const finished = recordingPort({ report: { kind: "chat", reference: "ollama/qwen3.8:27b" } });
    expect(await call(handlers(finished.port).benchModel, "POST", "/models/bench", flash)).toEqual({
      status: 200,
      body: { kind: "chat", reference: "ollama/qwen3.8:27b" },
    });
    expect(finished.benched).toEqual([flash]);
    const statuses = await Promise.all(
      (["busy", "missing", "unrecognized", "failed", "unreachable"] as const).map(
        async (refused) => {
          const { port } = recordingPort({ refused, error: `the bench was ${refused}` });
          const answer = await call(handlers(port).benchModel, "POST", "/models/bench", flash);
          return [refused, answer.status, answer.body];
        },
      ),
    );
    expect(statuses).toEqual([
      ["busy", 409, { error: "the bench was busy" }],
      ["missing", 404, { error: "the bench was missing" }],
      ["unrecognized", 422, { error: "the bench was unrecognized" }],
      ["failed", 500, { error: "the bench was failed" }],
      ["unreachable", 502, { error: "the bench was unreachable" }],
    ]);
  });

  it("read the last bench of the model the query names", async () => {
    const { port, read } = recordingPort({ report: {} });
    expect(await call(handlers(port).readModelBench, "GET", benchQuery)).toEqual({
      status: 200,
      body: { report: null },
    });
    expect(read).toEqual([flash]);
  });

  it("normalize targets and license requests", () => {
    expect(modelTargetOf({ endpoint: `${spark}/v1`, model: "qwen3.8:27b", junk: 1 })).toEqual({
      endpoint: `${spark}/v1`,
      model: "qwen3.8:27b",
    });
    expect(modelTargetOf(null)).toBeUndefined();
    expect(licenseRequestOf(flash)).toBeUndefined();
  });
});

describe("the models family over the engine's stewarded inventory", () => {
  it("acknowledges, lists the acknowledgement, benches and reads the bench back", async () => {
    const at = "2026-11-05T12:00:00.000Z";
    const flashRow = {
      id: "qwen3.8-flash-next",
      installed: true,
      loaded: true,
      contextAllocated: 131_072,
      health: { state: "up", resident: true, detail: "fixture", checkedAt: at },
      classes: [],
      ineligible: [],
      license: null,
      licenseAcknowledgement: "unknown",
      cost: { source: "local_estimate", usdPerMillionInput: 0, usdPerMillionOutput: 0 },
    } as const;
    const port: ModelsPort = stewardedInventory(
      {
        list: async () => ({
          generatedAt: at,
          nodes: [
            {
              node: "spark-ad4d",
              servers: [
                {
                  kind: "llama-server",
                  root: spark,
                  port: 9931,
                  source: "advertised",
                  auth: "none",
                  fingerprint: "fp",
                  version: "b12122",
                  health: flashRow.health,
                  models: [{ ...flashRow, classes: [], ineligible: [] }],
                },
              ],
            },
          ],
        }),
        probe: async () => {
          throw new Error("not probed here");
        },
      },
      {
        licenses: memoryLicenseBook({ now: () => new Date(at) }),
        benches: benchBook({
          openers: [
            async () => ({
              ok: true,
              reference: "llama-server/qwen3.8-flash-next",
              fingerprint: {
                id: "fp",
                kind: "llama-server",
                version: "b12122",
                build: null,
                routes: [],
              },
              subject: { kind: "chat", provider: new MockProvider([]) },
            }),
          ],
          trace: async () => ({ name: "empty", tools: [], turns: [] }),
        }),
        slate: testSlate,
      },
    );
    const h = handlers(port);
    const listedModel = async () => {
      const { body } = await call(h.listModels, "GET", "/models");
      return (body as ListedModels).nodes[0]?.servers[0]?.models[0];
    };
    expect(await listedModel()).toMatchObject({
      license: "qwen-community-1.0",
      licenseAcknowledgement: "required",
      released: "2026-08-24",
      acknowledgedAt: null,
    });
    expect(
      (await call(h.acknowledgeModelLicense, "POST", "/models/acknowledgements", flashLicense))
        .body,
    ).toEqual({ model: "qwen3.8-flash-next", license: "qwen-community-1.0", acknowledgedAt: at });
    expect(await listedModel()).toMatchObject({ acknowledgedAt: at });
    expect(await call(h.readModelBench, "GET", benchQuery)).toEqual({
      status: 200,
      body: { report: null },
    });
    const benched = await call(h.benchModel, "POST", "/models/bench", flash);
    expect(benched).toMatchObject({
      status: 200,
      body: { kind: "chat", reference: "llama-server/qwen3.8-flash-next", repeats: 3 },
    });
    expect(await call(h.readModelBench, "GET", benchQuery)).toEqual({
      status: 200,
      body: { report: benched.body },
    });
  });

  it("answers inherits for keywork's unverified OpenRouter default in every class, and unconfigured with no default", async () => {
    const at = "2026-11-06T12:00:00.000Z";
    const openrouter: ProviderRegistration = {
      name: "openrouter",
      protocol: "chat-completions",
      endpoint: "https://openrouter.ai/api/v1",
      credential: { kind: "present", handle: { id: "openrouter", label: "OPENROUTER_API_KEY" } },
      models: [],
      openCatalog: true,
      enabled: true,
      defaultModel: "openai/gpt-5-mini",
    };
    const inventoryWith = (inherit: () => { provider: string; model: string } | undefined) =>
      stewardedInventory(
        {
          list: async () => ({ generatedAt: at, nodes: [] }),
          probe: async () => {
            throw new Error("not probed here");
          },
        },
        {
          licenses: memoryLicenseBook({ now: () => new Date(at) }),
          benches: benchBook({
            openers: [],
            trace: async () => ({ name: "", tools: [], turns: [] }),
          }),
          registrations: () => [openrouter],
          inherit,
          now: () => new Date(at),
        },
      );
    const gpt = { provider: "openrouter", model: "openai/gpt-5-mini" };

    const listed = await call(handlers(inventoryWith(() => gpt)).listModels, "GET", "/models");
    const body = listed.body as { market: unknown; inherits: unknown };
    expect(listed.status).toBe(200);
    expect(body.market).toMatchObject([{ kind: "openrouter", health: { state: "unverified" } }]);
    expect(body.inherits).toEqual({
      strong: gpt,
      loop: gpt,
      decide: {
        ...gpt,
        decider: "builtin",
        detail:
          "openrouter/openai/gpt-5-mini has no decision endpoint or logprobs, so the built-in decider asks it each question",
      },
      vision: gpt,
    });

    const bare = await call(handlers(inventoryWith(() => undefined)).listModels, "GET", "/models");
    expect((bare.body as { inherits: { strong: unknown } }).inherits.strong).toEqual({
      refused: "unconfigured",
      detail: "this host has no default model to inherit",
    });
  });
});
