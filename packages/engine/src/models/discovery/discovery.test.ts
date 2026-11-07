import { afterEach, describe, expect, it } from "vitest";
import { type NodeManifest, parseManifest } from "../../mesh/discovery/manifest.ts";
import { probeHttp } from "../adapters/http.ts";
import { FixtureServer, loadFixture } from "../adapters/testing/fixture-server.ts";
import { CapabilityCache } from "../capabilities/cache.ts";
import { BreakerBoard } from "../health/breaker.ts";
import {
  advertiseLocalServers,
  type DiscoveredServer,
  knownServerPorts,
  licenseAcknowledgementFor,
  ModelInventory,
  mergeDiscovered,
  rootOf,
  scanHost,
  serversFromManifest,
} from "./index.ts";

const now = () => new Date("2026-11-05T12:00:00.000Z");
const servers: FixtureServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function started(server: FixtureServer): Promise<FixtureServer> {
  servers.push(server);
  await server.listen();
  return server;
}

function manifestWith(modelServers: NodeManifest["modelServers"]): NodeManifest {
  const manifest = parseManifest({
    manifest: 1,
    product: { name: "keywork", version: "0.0.1" },
    machine: {
      name: "spark-ad4d",
      os: "linux",
      arch: "arm64",
      stableId: null,
      addresses: ["100.64.0.7"],
    },
    roles: ["host"],
    workshop: { substrates: [] },
    gpus: [],
    modelServers,
    capabilities: [],
    generatedAt: "2026-11-05T12:00:00.000Z",
  });
  if (manifest === null) throw new Error("the manifest fixture no longer matches E3a's schema");
  return manifest;
}

describe("discovery by port probing", () => {
  it("fingerprints each hit by its native route before trusting it", async () => {
    const ollama = await started(new FixtureServer(loadFixture("ollama-0.40.14")));
    const llama = await started(new FixtureServer(loadFixture("llama-server-b12122")));
    const lister = await started(
      new FixtureServer().route("GET /v1/models", { body: { data: [{ id: "anything" }] } }),
    );
    const locked = await started(
      new FixtureServer().route("GET /v1/models", { status: 401, body: {} }),
    );
    const found = await scanHost("moak-main", "127.0.0.1", {
      http: probeHttp(),
      now,
      ports: [
        { port: ollama.port, kinds: ["ollama"] },
        { port: llama.port, kinds: ["llama-server"] },
        { port: lister.port, kinds: ["llama-swap"] },
        { port: locked.port, kinds: ["lm-studio"] },
        { port: 1, kinds: ["vllm"] },
      ],
    });
    expect(found.map((server) => [server.kind, server.auth, server.source])).toEqual([
      ["ollama", "none", "probed"],
      ["llama-server", "none", "probed"],
      ["openai-compatible", "none", "probed"],
      ["openai-compatible", "key", "probed"],
    ]);
  });

  it("probes the research's default ports", async () => {
    expect(knownServerPorts.map((known) => known.port)).toEqual([
      11434, 9931, 8080, 1234, 8000, 30000,
    ]);
  });

  it("advertises local servers in the shape of E3a's manifest", async () => {
    const ollama = await started(new FixtureServer(loadFixture("ollama-0.40.14")));
    const adverts = await advertiseLocalServers({
      http: probeHttp(),
      now,
      ports: [{ port: ollama.port, kinds: ["ollama"] }],
    });
    expect(adverts).toEqual([
      {
        kind: "ollama",
        port: ollama.port,
        auth: "none",
        installed: ["qwen3.8:27b", "nimble:latest"],
        loaded: ["qwen3.8:27b"],
      },
    ]);
    expect(manifestWith(adverts).modelServers).toEqual(adverts);
  });
});

describe("discovery from manifests", () => {
  it("prefers advertised servers over probed ones at the same root", () => {
    const manifest = manifestWith([
      { kind: "llama-server", port: 9931, auth: "key", installed: ["a"], loaded: [] },
      { kind: "something-new", port: 7777, auth: "none", installed: [], loaded: [] },
    ]);
    const advertised = serversFromManifest("spark-ad4d", "100.64.0.7", manifest);
    expect(advertised.map((server) => [server.root, server.kind, server.auth])).toEqual([
      ["http://100.64.0.7:9931", "llama-server", "key"],
      ["http://100.64.0.7:7777", "openai-compatible", "none"],
    ]);
    const [first] = advertised;
    if (first === undefined) throw new Error("expected an advertised server");
    const probed: DiscoveredServer[] = [
      { ...first, source: "probed", auth: "none", advertised: null },
      {
        node: "spark-ad4d",
        root: "http://100.64.0.7:11434",
        port: 11434,
        kind: "ollama",
        source: "probed",
        auth: "none",
        advertised: null,
      },
    ];
    const merged = mergeDiscovered(advertised, probed);
    expect(merged.map((server) => [server.root, server.source])).toEqual([
      ["http://100.64.0.7:9931", "advertised"],
      ["http://100.64.0.7:7777", "advertised"],
      ["http://100.64.0.7:11434", "probed"],
    ]);
  });

  it("brackets IPv6 tailnet addresses in roots", () => {
    expect(rootOf("fd7a:115c:a1e0::7", 11434)).toBe("http://[fd7a:115c:a1e0::7]:11434");
  });
});

describe("ModelInventory", () => {
  it("lists loaded, installed, eligible classes, license and cost per node", async () => {
    const ollama = await started(new FixtureServer(loadFixture("ollama-0.40.14")));
    const inventory = new ModelInventory({
      cache: new CapabilityCache(now),
      now,
      nodes: async () => [
        {
          node: "moak-main",
          address: "127.0.0.1",
          manifest: manifestWith([
            {
              kind: "ollama",
              port: ollama.port,
              auth: "none",
              installed: ["qwen3.8:27b", "nimble:latest"],
              loaded: ["qwen3.8:27b"],
            },
          ]),
        },
      ],
    });
    const report = await inventory.list();
    expect(report.generatedAt).toBe("2026-11-05T12:00:00.000Z");
    const [server] = report.nodes[0]?.servers ?? [];
    expect(server).toMatchObject({
      kind: "ollama",
      source: "advertised",
      fingerprint: "ollama@0.40.14",
      health: { state: "up" },
    });
    expect(server?.models).toEqual([
      {
        id: "qwen3.8:27b",
        installed: true,
        loaded: true,
        contextAllocated: 32768,
        health: expect.objectContaining({ state: "up", resident: true }),
        classes: ["vision"],
        ineligible: [
          { class: "strong", missing: ["contextAllocated"] },
          { class: "loop", missing: ["contextAllocated", "decodeTokensPerSecond"] },
          { class: "decide", missing: ["decisionEndpoint"] },
        ],
        license: "apache-2.0",
        licenseAcknowledgement: "not-required",
        cost: { source: "local_estimate", usdPerMillionInput: 0, usdPerMillionOutput: 0 },
      },
      expect.objectContaining({
        id: "nimble:latest",
        loaded: false,
        classes: ["decide"],
        licenseAcknowledgement: "unknown",
        health: expect.objectContaining({ resident: false }),
      }),
    ]);
  });

  it("shows an advertised server it cannot reach as down with its advertised models", async () => {
    const gone = new FixtureServer();
    const port = (await started(gone)).port;
    await gone.close();
    servers.splice(servers.indexOf(gone), 1);
    const inventory = new ModelInventory({
      cache: new CapabilityCache(now),
      now,
      http: probeHttp({ timeoutMs: 1000 }),
      nodes: async () => [
        {
          node: "spark-ad4d",
          address: "127.0.0.1",
          manifest: manifestWith([
            { kind: "llama-server", port, auth: "none", installed: ["gpt-oss-120b"], loaded: [] },
          ]),
        },
      ],
    });
    const [server] = (await inventory.list({ node: "spark-ad4d" })).nodes[0]?.servers ?? [];
    expect(server?.health.state).toBe("down");
    expect(server?.models).toMatchObject([
      { id: "gpt-oss-120b", installed: true, loaded: false, classes: [] },
    ]);
    expect(server?.models[0]?.ineligible[0]).toEqual({
      class: "strong",
      missing: ["capability record"],
    });
  });

  it("marks a model down while its breaker is open", async () => {
    const ollama = await started(new FixtureServer(loadFixture("ollama-0.40.14")));
    const breakers = new BreakerBoard({ failureThreshold: 1 });
    breakers.for("moak-main", "qwen3.8:27b").failed("failure");
    const inventory = new ModelInventory({
      cache: new CapabilityCache(now),
      now,
      breakers,
      nodes: async () => [
        {
          node: "moak-main",
          address: "127.0.0.1",
          scan: false,
          manifest: manifestWith([
            { kind: "ollama", port: ollama.port, auth: "none", installed: [], loaded: [] },
          ]),
        },
      ],
    });
    const [server] = (await inventory.list()).nodes[0]?.servers ?? [];
    expect(server?.models.find((model) => model.id === "qwen3.8:27b")?.health.state).toBe("down");
  });

  it("filters by node", async () => {
    const inventory = new ModelInventory({
      cache: new CapabilityCache(now),
      now,
      nodes: async () => [
        { node: "moak-main", address: "127.0.0.1" },
        { node: "spark-ad4d", address: "127.0.0.1" },
      ],
    });
    expect((await inventory.list({ node: "spark-ad4d" })).nodes).toEqual([
      { node: "spark-ad4d", servers: [] },
    ]);
  });

  it("probes one endpoint on demand, including the tool-call behaviour probe", async () => {
    const llama = await started(new FixtureServer(loadFixture("llama-server-b12122")));
    const inventory = new ModelInventory({
      cache: new CapabilityCache(now),
      now,
      nodes: async () => [],
    });
    const report = await inventory.probe({
      endpoint: `http://127.0.0.1:${llama.port}/v1`,
      model: "qwen3.8-27b",
      behaviour: true,
    });
    expect(report).toMatchObject({
      root: `http://127.0.0.1:${llama.port}`,
      status: "recognized",
      fingerprint: { id: "llama-server@b12122" },
      health: { state: "up", resident: true },
      listedOnly: [],
      detail: null,
    });
    expect(
      report.records.map((record) => [record.model, record.tools.known && record.tools.value]),
    ).toEqual([["qwen3.8-27b", true]]);
  });
});

describe("licenseAcknowledgementFor", () => {
  it("asks for acknowledgement on non-permissive licenses", () => {
    expect(licenseAcknowledgementFor("Apache-2.0")).toBe("not-required");
    expect(licenseAcknowledgementFor("MIT")).toBe("not-required");
    expect(licenseAcknowledgementFor("qwen-community-1.0")).toBe("required");
    expect(licenseAcknowledgementFor("NVIDIA Open Model License")).toBe("required");
    expect(licenseAcknowledgementFor(null)).toBe("unknown");
  });
});
