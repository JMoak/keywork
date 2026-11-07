import { describe, expect, it } from "vitest";
import { CapabilityCache } from "./cache.ts";
import { eligibleClasses, missingFor } from "./eligibility.ts";
import { blankRecord, known, withMeasuredDecode } from "./record.ts";
import type { CapabilityRecord, ServerFingerprint } from "./types.ts";

const now = () => new Date("2026-11-05T12:00:00.000Z");
const root = "http://100.101.102.103:11434";
const fingerprint: ServerFingerprint = {
  id: "ollama@0.40.14",
  kind: "ollama",
  version: "0.40.14",
  build: null,
  routes: ["/api/version"],
};

function record(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    ...blankRecord(root, "qwen3.6:35b-a3b", fingerprint, now().toISOString()),
    ...overrides,
  };
}

const route = { source: "native-route", route: "/api/show" } as const;

describe("CapabilityCache", () => {
  it("round-trips through a snapshot with negative capabilities intact", () => {
    const cache = new CapabilityCache(now);
    cache.store(record());
    cache.fieldMemory(root, "qwen3.6:35b-a3b").reject("parallel_tool_calls", 422);
    const restored = CapabilityCache.restore(JSON.parse(JSON.stringify(cache.snapshot())), now);
    expect(restored.kindOf(root)).toBe("ollama");
    expect(restored.record(root, "qwen3.6:35b-a3b")?.rejectedFields).toEqual([
      { field: "parallel_tool_calls", status: 422, learnedAt: "2026-11-05T12:00:00.000Z" },
    ]);
    expect(restored.fieldMemory(root, "qwen3.6:35b-a3b").rejects("parallel_tool_calls")).toBe(true);
  });

  it("remembers a refusal once", () => {
    const cache = new CapabilityCache(now);
    cache.store(record());
    const memory = cache.fieldMemory(root, "qwen3.6:35b-a3b");
    memory.reject("n", 400);
    memory.reject("n", 400);
    expect(cache.record(root, "qwen3.6:35b-a3b")?.rejectedFields).toHaveLength(1);
  });
});

describe("class eligibility", () => {
  it("never treats an unknown capability as present", () => {
    expect(eligibleClasses(record())).toEqual([]);
    expect(missingFor(record(), "loop").map((missing) => missing.capability)).toEqual([
      "tools",
      "contextAllocated",
      "decodeTokensPerSecond",
    ]);
  });

  it("admits loop only with tools, 64K allocated and measured decode at 40 tok/s", () => {
    const capable = record({
      tools: known(true, route),
      contextAllocated: known(65_536, { source: "native-route", route: "/api/ps" }),
    });
    expect(missingFor(capable, "loop")).toEqual([
      {
        capability: "decodeTokensPerSecond",
        needs: "decode measured at or above 40 tok/s on this node",
      },
    ]);
    expect(missingFor(withMeasuredDecode(capable, 39.9, now().toISOString()), "loop")).toHaveLength(
      1,
    );
    expect(eligibleClasses(withMeasuredDecode(capable, 76.9, now().toISOString()))).toEqual([
      "loop",
    ]);
  });

  it("admits decide on a decision endpoint or on logprobs", () => {
    expect(eligibleClasses(record({ decisionEndpoint: known("/v1/systemone", route) }))).toEqual([
      "decide",
    ]);
    expect(
      eligibleClasses(record({ logprobs: known(true, { source: "server-delta", rule: "S14" }) })),
    ).toEqual(["decide"]);
    expect(eligibleClasses(record({ decisionEndpoint: known(null, route) }))).toEqual([]);
  });

  it("admits vision on any image input kind but none", () => {
    expect(eligibleClasses(record({ imageInput: known("none", route) }))).toEqual([]);
    expect(eligibleClasses(record({ imageInput: known("base64", route) }))).toEqual(["vision"]);
  });
});
