import { MockProvider } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { fixtureDocument } from "../contract-fixtures.ts";
import { EventLog } from "../events.ts";
import { operationOf } from "../openapi.ts";
import { memorySessionHost } from "../testing.ts";
import type { RouteHandler } from "./family.ts";
import {
  type ModelsFilter,
  type ModelsPort,
  type ModelsProbeRequest,
  modelFamilyFor,
  modelRoutes,
  probeRequestOf,
} from "./models.ts";

const origin = "http://127.0.0.1:4770";

const report = {
  generatedAt: "2026-11-05T12:00:00.000Z",
  nodes: [{ node: "spark-ad4d", servers: [] }],
};

function recordingPort() {
  const lists: ModelsFilter[] = [];
  const probes: ModelsProbeRequest[] = [];
  const port: ModelsPort = {
    list: async (filter) => {
      lists.push(filter);
      return report;
    },
    probe: async (request) => {
      probes.push(request);
      return { root: "http://127.0.0.1:9931", status: "recognized", records: [] };
    },
  };
  return { port, lists, probes };
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
): Promise<{ status: number; body: Record<string, unknown> }> {
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
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the models routes", () => {
  it("answer 503 on a host that serves no model inventory", async () => {
    const h = handlers(undefined);
    expect((await call(h.listModels, "GET", "/models")).status).toBe(503);
    expect(
      (await call(h.probeModels, "POST", "/models/probe", { endpoint: "http://127.0.0.1:11434" }))
        .status,
    ).toBe(503);
  });

  it("list every node, or one with ?node=", async () => {
    const { port, lists } = recordingPort();
    const h = handlers(port);
    expect(await call(h.listModels, "GET", "/models")).toEqual({ status: 200, body: report });
    await call(h.listModels, "GET", "/models?node=spark-ad4d");
    await call(h.listModels, "GET", "/models?node=");
    expect(lists).toEqual([{}, { node: "spark-ad4d" }, {}]);
  });

  it("probe a well-formed endpoint and pass only the fields it names", async () => {
    const { port, probes } = recordingPort();
    const h = handlers(port);
    const answer = await call(h.probeModels, "POST", "/models/probe", {
      endpoint: "http://100.64.0.7:9931/v1",
      model: "qwen3.8-27b",
      behaviour: true,
      refresh: false,
    });
    expect(answer).toEqual({
      status: 200,
      body: { root: "http://127.0.0.1:9931", status: "recognized", records: [] },
    });
    expect(probes).toEqual([
      { endpoint: "http://100.64.0.7:9931/v1", model: "qwen3.8-27b", behaviour: true },
    ]);
  });

  it("refuse a malformed probe with 400 and never reach the port", async () => {
    const { port, probes } = recordingPort();
    const h = handlers(port);
    for (const body of [
      {},
      { endpoint: "" },
      { endpoint: "file:///etc/passwd" },
      { endpoint: "not a url" },
      { endpoint: "http://127.0.0.1:11434", model: "" },
      { endpoint: "http://127.0.0.1:11434", behaviour: "yes" },
      { endpoint: "http://127.0.0.1:11434", refresh: 1 },
      "not json",
    ]) {
      expect((await call(h.probeModels, "POST", "/models/probe", body)).status).toBe(400);
    }
    expect(probes).toEqual([]);
  });

  it("declare an authenticated GET /models and POST /models/probe with a required body", () => {
    expect(modelRoutes.map((route) => [route.method, route.path, route.operationId])).toEqual([
      ["GET", "/models", "listModels"],
      ["POST", "/models/probe", "probeModels"],
    ]);
    expect(modelRoutes.every((route) => route.authenticated)).toBe(true);
    expect(operationOf(modelRoutes[1]).requestBody?.required).toBe(true);
    expect(operationOf(modelRoutes[0]).requestBody).toBeUndefined();
  });

  it("normalize a probe request", () => {
    expect(probeRequestOf({ endpoint: "https://spark.tail1234.ts.net:11434" })).toEqual({
      endpoint: "https://spark.tail1234.ts.net:11434",
    });
    expect(probeRequestOf(null)).toBeUndefined();
  });
});
