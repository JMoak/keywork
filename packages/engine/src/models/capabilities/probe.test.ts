import { afterEach, describe, expect, it } from "vitest";
import { probeHttp } from "../adapters/http.ts";
import { FixtureServer, loadFixture } from "../adapters/testing/fixture-server.ts";
import { CapabilityCache } from "./cache.ts";
import { probeServer } from "./probe.ts";
import { capabilityNames, knownCapabilities } from "./record.ts";

const now = () => new Date("2026-11-05T12:00:00.000Z");
const servers: FixtureServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(server: FixtureServer): Promise<string> {
  servers.push(server);
  return server.listen();
}

describe("probeServer", () => {
  it("never marks a capability from /v1/models alone", async () => {
    const root = await serve(
      new FixtureServer().route("GET /v1/models", {
        body: {
          object: "list",
          data: [
            { id: "gpt-4o-vision-tools-128k", object: "model" },
            { id: "qwen3.8-27b-instruct-tools", object: "model" },
          ],
        },
      }),
    );
    const cache = new CapabilityCache(now);
    const result = await probeServer(root, { http: probeHttp(), cache, now });
    expect(result).toEqual({
      status: "unrecognized",
      root,
      listedOnly: ["gpt-4o-vision-tools-128k", "qwen3.8-27b-instruct-tools"],
    });
    expect(cache.kindOf(root)).toBeUndefined();
    expect(cache.record(root, "gpt-4o-vision-tools-128k")).toBeUndefined();
    expect(cache.recordsFor(root)).toEqual([]);
  });

  it("leaves every capability unknown when a recognized server's native routes stay silent", async () => {
    const root = await serve(
      new FixtureServer()
        .route("GET /api/version", { body: { version: "0.40.14" } })
        .route("GET /api/tags", { body: { models: [{ name: "mystery:latest" }] } })
        .route("GET /api/ps", { body: { models: [] } })
        .route("POST /api/show", { status: 500, body: { error: "boom" } })
        .route("GET /v1/models", {
          body: { data: [{ id: "mystery:latest", capabilities: ["tools", "vision"] }] },
        }),
    );
    const result = await probeServer(root, {
      http: probeHttp(),
      cache: new CapabilityCache(now),
      now,
    });
    if (result.status !== "recognized")
      throw new Error(`expected recognized, got ${result.status}`);
    const [record] = result.records;
    expect(record?.tools).toMatchObject({ known: false });
    expect(record?.imageInput).toMatchObject({ known: false });
    expect(knownCapabilities(record ?? fail())).toEqual([
      "protocols",
      "toolChoice",
      "logprobs",
      "usageInStream",
      "prefixCacheReport",
    ]);
  });

  it("probes a recognized server once and serves the cache until the fingerprint changes", async () => {
    const server = new FixtureServer(loadFixture("ollama-0.40.14"));
    const root = await serve(server);
    const cache = new CapabilityCache(now);
    const first = await probeServer(root, { http: probeHttp(), cache, now });
    expect(first.status).toBe("recognized");
    expect(cache.kindOf(root)).toBe("ollama");
    expect(server.requestsTo("POST /api/show")).toHaveLength(2);

    await probeServer(root, { http: probeHttp(), cache, now });
    expect(server.requestsTo("POST /api/show")).toHaveLength(2);

    cache.fieldMemory(root, "qwen3.8:27b").reject("reasoning_effort", 400);
    expect(cache.record(root, "qwen3.8:27b")?.rejectedFields).toEqual([
      { field: "reasoning_effort", status: 400, learnedAt: "2026-11-05T12:00:00.000Z" },
    ]);

    server.route("GET /api/version", { body: { version: "0.40.15" } });
    const upgraded = await probeServer(root, { http: probeHttp(), cache, now });
    expect(upgraded.status === "recognized" && upgraded.fingerprint.id).toBe("ollama@0.40.15");
    expect(server.requestsTo("POST /api/show")).toHaveLength(4);
    expect(cache.record(root, "qwen3.8:27b")?.rejectedFields).toEqual([]);
    expect(cache.fieldMemory(root, "qwen3.8:27b").rejects("reasoning_effort")).toBe(false);
  });

  it("runs the tool-call behaviour probe only when asked", async () => {
    const server = new FixtureServer(loadFixture("llama-server-b12122"));
    const root = await serve(server);
    const cache = new CapabilityCache(now);
    const quiet = await probeServer(root, {
      http: probeHttp(),
      cache,
      now,
      models: ["qwen3.8-27b"],
    });
    expect(quiet.status === "recognized" && quiet.records[0]?.tools.known).toBe(false);
    expect(server.requestsTo("POST /v1/chat/completions")).toHaveLength(0);

    const probed = await probeServer(root, {
      http: probeHttp(),
      cache,
      now,
      models: ["qwen3.8-27b"],
      behaviour: true,
    });
    expect(probed.status === "recognized" && probed.records[0]?.tools).toMatchObject({
      known: true,
      value: true,
    });
    expect(server.requestsTo("POST /v1/chat/completions")).toHaveLength(1);
  });

  it("recognizes a server it has no adapter for by its native route, with no records", async () => {
    const root = await serve(
      new FixtureServer().route("GET /version", { body: { version: "0.32.0" } }),
    );
    const result = await probeServer(root, {
      http: probeHttp(),
      cache: new CapabilityCache(now),
      now,
    });
    expect(result).toMatchObject({
      status: "recognized",
      fingerprint: { id: "vllm@0.32.0", kind: "vllm", routes: ["/version"] },
      inventory: null,
      records: [],
    });
  });

  it("reports an unreachable endpoint", async () => {
    const server = new FixtureServer();
    const root = await server.listen();
    await server.close();
    const result = await probeServer(root, {
      http: probeHttp({ timeoutMs: 1000 }),
      cache: new CapabilityCache(now),
      now,
    });
    expect(result.status).toBe("unreachable");
  });

  it("knows every field of the record by name", () => {
    expect(new Set(capabilityNames).size).toBe(capabilityNames.length);
  });
});

function fail(): never {
  throw new Error("expected a record");
}
