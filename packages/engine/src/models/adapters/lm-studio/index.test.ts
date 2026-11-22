import { describe, expect, it, vi } from "vitest";
import { CapabilityCache } from "../../capabilities/cache.ts";
import { eligibleClasses } from "../../capabilities/eligibility.ts";
import { probeServer } from "../../capabilities/probe.ts";
import { EndpointUnreachableError, type HttpReply } from "../http.ts";
import type { ServerProbe } from "../types.ts";
import { lmStudioAdapter } from "./index.ts";

const root = "http://localhost:1234";
const now = () => new Date("2026-11-10T12:00:00Z");
const model = {
  key: "local/model",
  type: "llm",
  architecture: "test",
  max_context_length: 131_072,
  capabilities: { trained_for_tool_use: true, vision: false },
  loaded_instances: [{ id: "loaded-alias", config: { context_length: 8192 } }],
};

function fixture(models: unknown[]) {
  const calls: string[] = [];
  const get = vi.fn(async (url: string): Promise<HttpReply> => {
    calls.push(url);
    return url === `${root}/api/v1/models`
      ? { ok: true, status: 200, body: { models }, text: "" }
      : { ok: false, status: 404, body: {}, text: "" };
  });
  const post = vi.fn(async (): Promise<HttpReply> => {
    throw new Error("Discovery must not generate, download, or load models");
  });
  const probe: ServerProbe = { root, now, http: { get, post } };
  return { probe, calls, get, post };
}

describe("LM Studio native inventory", () => {
  it("uses native metadata, preserves instance IDs, and never promotes trained context to loaded context", async () => {
    const { probe, post } = fixture([model]);
    const cache = new CapabilityCache(now);
    const result = await probeServer(root, { ...probe, cache });
    expect(result.status).toBe("recognized");
    expect(cache.kindOf(root)).toBe("lm-studio");
    expect(cache.record(root, "loaded-alias")).toMatchObject({
      tools: { known: false },
      contextAllocated: { known: true, value: 8192 },
      contextTrained: { known: true, value: 131_072 },
    });
    const record = cache.record(root, "local/model");
    expect(record).toBeDefined();
    if (record !== undefined) expect(eligibleClasses(record)).not.toContain("strong");
    expect(await lmStudioAdapter.inventory(probe)).toMatchObject({
      installed: [{ id: "local/model" }],
      loaded: [{ id: "loaded-alias", contextAllocated: 8192 }],
    });
    expect(post).not.toHaveBeenCalled();
    expect(record?.contextAllocated.known).toBe(false);
    expect(await lmStudioAdapter.health(probe, model.key)).toMatchObject({ resident: false });
    expect(await lmStudioAdapter.health(probe, "loaded-alias")).toMatchObject({ resident: true });
  });

  it("keeps unloaded context unknown and embedding models out of text conversation", async () => {
    const { probe } = fixture([
      { ...model, loaded_instances: [] },
      { key: "embedding", type: "embedding", loaded_instances: [], max_context_length: 2048 },
    ]);
    const fingerprint = await lmStudioAdapter.fingerprint(probe);
    expect(fingerprint).toBeDefined();
    if (fingerprint === undefined) return;
    const unloaded = await lmStudioAdapter.describe(probe, model.key, fingerprint);
    expect(unloaded.contextAllocated.known).toBe(false);
    expect(await lmStudioAdapter.health(probe, model.key)).toMatchObject({
      state: "up",
      resident: false,
    });
    const embedding = await lmStudioAdapter.describe(probe, "embedding", fingerprint);
    expect(embedding.modalities).toMatchObject({ known: true, value: { output: ["embedding"] } });
    expect(embedding.tools.known).toBe(false);
  });

  it("never treats a generic OpenAI model list as native capability evidence", async () => {
    const { probe, get } = fixture([]);
    get.mockResolvedValue({
      ok: true,
      status: 200,
      body: { data: [{ id: "model-with-tools-128k" }] },
      text: "",
    });
    expect(await lmStudioAdapter.fingerprint(probe)).toBeUndefined();
  });

  it("refreshes allocated context after a load change without inventing a server version", async () => {
    const { probe, get } = fixture([model]);
    const cache = new CapabilityCache(now);
    await probeServer(root, { ...probe, cache });
    get.mockImplementation(async (url) => ({
      ok: url.endsWith("/api/v1/models"),
      status: url.endsWith("/api/v1/models") ? 200 : 404,
      text: "",
      body: {
        models: [
          {
            ...model,
            loaded_instances: [{ id: "loaded-alias", config: { context_length: 131_072 } }],
          },
        ],
      },
    }));
    await probeServer(root, { ...probe, cache });
    const record = cache.record(root, "loaded-alias");
    expect(record?.contextAllocated).toMatchObject({ known: true, value: 131_072 });
    expect(record?.server.version).toBeNull();
    if (record !== undefined) expect(eligibleClasses(record)).not.toContain("strong");
  });

  it("ignores malformed loaded instances and accepts an empty native inventory", async () => {
    const empty = fixture([]);
    expect(await lmStudioAdapter.fingerprint(empty.probe)).toMatchObject({ kind: "lm-studio" });
    const { probe } = fixture([
      { ...model, loaded_instances: [null, {}, { id: "" }] },
      { ...model, key: "" },
    ]);
    expect((await lmStudioAdapter.inventory(probe)).loaded).toEqual([]);
    expect(await lmStudioAdapter.health(probe, model.key)).toMatchObject({ resident: false });
  });

  it("reports unavailable or missing models accurately", async () => {
    const { probe, get } = fixture([]);
    expect(await lmStudioAdapter.health(probe, "missing")).toMatchObject({
      state: "down",
      resident: false,
    });
    get.mockRejectedValue(new EndpointUnreachableError(root, "stopped"));
    expect(await lmStudioAdapter.health(probe)).toMatchObject({ state: "down" });
  });
});
