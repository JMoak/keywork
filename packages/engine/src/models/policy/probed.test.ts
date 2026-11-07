import { describe, expect, it } from "vitest";
import type { InferenceBinding } from "../../inference/types.ts";
import { CapabilityCache } from "../capabilities/cache.ts";
import { blankRecord } from "../capabilities/record.ts";
import type { ServerFingerprint } from "../capabilities/types.ts";
import { probedCapabilities } from "./probed.ts";

const now = () => new Date("2026-11-05T12:00:00.000Z");

const spark: ServerFingerprint = {
  id: "llama-server:b12122",
  kind: "llama-server",
  version: "b12122",
  build: null,
  routes: ["/props"],
};

function binding(endpoint: string, model: string): InferenceBinding {
  return {
    protocol: "chat-completions",
    reference: { provider: "spark", model },
    registration: { name: "spark", endpoint },
  } as unknown as InferenceBinding;
}

describe("probedCapabilities", () => {
  it("answers the probed record of the binding's server root and model, else nothing", () => {
    const cache = new CapabilityCache(now);
    const record = blankRecord("http://127.0.0.1:9931", "qwen3.8-27b", spark, now().toISOString());
    cache.store(record);
    const capabilityOf = probedCapabilities(cache);

    expect(capabilityOf(binding("http://127.0.0.1:9931/v1", "qwen3.8-27b"))).toEqual(record);
    expect(capabilityOf(binding("http://127.0.0.1:9931/v1", "other"))).toBeUndefined();
    expect(capabilityOf(binding("http://127.0.0.1:11434/v1", "qwen3.8-27b"))).toBeUndefined();
  });
});
