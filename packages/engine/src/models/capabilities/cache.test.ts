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
});

describe("class eligibility", () => {
  it("never treats unknown tool calls as present, and learns context and decode in use", () => {
    expect(eligibleClasses(record())).toEqual([]);
    expect(missingFor(record(), "loop").map((missing) => missing.capability)).toEqual(["tools"]);
  });

  it("admits loop with tools and no allocated context known short of 64K, whatever its decode", () => {
    const capable = record({ tools: known(true, route) });
    expect(missingFor(capable, "loop")).toEqual([]);
    const short = { ...capable, contextAllocated: known(32_768, route) };
    expect(missingFor(short, "loop").map((missing) => missing.capability)).toEqual([
      "contextAllocated",
    ]);
    const allocated = { ...capable, contextAllocated: known(65_536, route) };
    expect(eligibleClasses(withMeasuredDecode(allocated, 12.5, now().toISOString()))).toEqual([
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
});
