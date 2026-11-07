import { describe, expect, it } from "vitest";
import { type NodeManifest, parseManifest } from "../../mesh/discovery/manifest.ts";
import { EndpointUnreachableError, type HttpReply, type ProbeHttp } from "../adapters/http.ts";
import { CapabilityCache } from "../capabilities/cache.ts";
import { ModelInventory, type ModelsChange } from "./inventory.ts";

describe("models.changed from the inventory", () => {
  it("stays quiet on the first look and while nothing moves", async () => {
    const { inventory, changes } = watched();
    await inventory.list();
    await inventory.list();
    expect(changes).toEqual([]);
  });

  it("says health when a server comes up or goes down", async () => {
    const { inventory, changes, http } = watched();
    await inventory.list();
    http.up = true;
    await inventory.list();
    http.up = false;
    await inventory.list();
    expect(changes).toEqual([
      { node: "spark-ad4d", reason: "health" },
      { node: "spark-ad4d", reason: "health" },
    ]);
  });

  it("says manifest when the node advertises a different set of servers", async () => {
    const { inventory, changes, advertise } = watched();
    await inventory.list();
    advertise([11434, 9931]);
    await inventory.list();
    expect(changes).toEqual([{ node: "spark-ad4d", reason: "manifest" }]);
  });

  it("says probe when the inventory's own scan finds a different set of servers", async () => {
    const changes: ModelsChange[] = [];
    const http = switchableHttp();
    const inventory = new ModelInventory({
      cache: new CapabilityCache(),
      http,
      nodes: async () => [{ node: "moak-main", address: "127.0.0.1", scan: true }],
      announce: { node: "moak-main", changed: (change) => changes.push(change) },
    });
    await inventory.list();
    http.up = true;
    await inventory.list();
    expect(changes).toEqual([{ node: "moak-main", reason: "probe" }]);
  });

  it("says probe for the inventory's own node after any probe", async () => {
    const { inventory, changes } = watched();
    await inventory.probe({ endpoint: "http://127.0.0.1:11434" });
    expect(changes).toEqual([{ node: "moak-main", reason: "probe" }]);
  });
});

interface SwitchableHttp extends ProbeHttp {
  up: boolean;
}

function watched() {
  const changes: ModelsChange[] = [];
  const http = switchableHttp();
  let ports = [11434];
  const inventory = new ModelInventory({
    cache: new CapabilityCache(),
    http,
    nodes: async () => [
      { node: "spark-ad4d", address: "100.64.0.7", scan: false, manifest: manifestServing(ports) },
    ],
    announce: { node: "moak-main", changed: (change) => changes.push(change) },
  });
  return {
    inventory,
    changes,
    http,
    advertise: (next: number[]) => {
      ports = next;
    },
  };
}

function switchableHttp(): SwitchableHttp {
  const http: SwitchableHttp = {
    up: false,
    get: async (url) => {
      if (!http.up) throw new EndpointUnreachableError(url, "down in this test");
      return url.endsWith("/v1/models") ? reply(200, { data: [] }) : reply(404, null);
    },
    post: async (url) => {
      throw new EndpointUnreachableError(url, "down in this test");
    },
  };
  return http;
}

function reply(status: number, body: unknown): HttpReply {
  return { status, ok: status < 400, body, text: JSON.stringify(body) };
}

function manifestServing(ports: readonly number[]): NodeManifest {
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
    modelServers: ports.map((port) => ({
      kind: "openai-compatible",
      port,
      auth: "none",
      installed: [],
      loaded: [],
    })),
    capabilities: [],
    generatedAt: "2026-11-05T12:00:00.000Z",
  });
  if (manifest === null) throw new Error("the manifest fixture no longer matches E3a's schema");
  return manifest;
}
