import type { FetchLike } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { verifyEndpoint } from "./verify.ts";

const now = () => new Date("2026-08-21T10:00:00.000Z");

function answering(
  status: number,
  body: unknown,
): { fetchFn: FetchLike; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, ...(init !== undefined && { init }) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetchFn, calls };
}

describe("verifyEndpoint", () => {
  it("performs exactly one GET on <endpoint>/models with the given headers and reports sorted ids", async () => {
    const { fetchFn, calls } = answering(200, {
      data: [{ id: "zeta" }, { id: "alpha" }, { object: "x" }],
    });
    const report = await verifyEndpoint({
      endpoint: "http://localhost:11434/v1",
      headers: { authorization: "Bearer k" },
      fetchFn,
      now,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/models");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer k" });
    expect(report).toEqual({ ok: true, at: "2026-08-21T10:00:00.000Z", models: ["alpha", "zeta"] });
  });

  it("accepts a bare array of ids and an unparseable body as an empty inventory", async () => {
    expect(
      await verifyEndpoint({
        endpoint: "http://localhost:1/v1",
        headers: {},
        fetchFn: answering(200, ["b", "a"]).fetchFn,
        now,
      }),
    ).toMatchObject({
      ok: true,
      models: ["a", "b"],
    });
    expect(
      await verifyEndpoint({
        endpoint: "http://localhost:1/v1",
        headers: {},
        fetchFn: answering(200, "nope").fetchFn,
        now,
      }),
    ).toMatchObject({
      ok: true,
      models: [],
    });
  });

  it("reports a non-2xx answer with its status and an excerpt", async () => {
    const report = await verifyEndpoint({
      endpoint: "https://api.example/v1",
      headers: {},
      fetchFn: answering(401, "invalid api key").fetchFn,
      now,
    });
    expect(report).toEqual({
      ok: false,
      at: "2026-08-21T10:00:00.000Z",
      reason: "HTTP 401 from https://api.example/v1/models: invalid api key",
    });
  });

  it("reports an unreachable endpoint without throwing", async () => {
    const failing: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const report = await verifyEndpoint({
      endpoint: "http://localhost:9/v1",
      headers: {},
      fetchFn: failing,
      now,
    });
    expect(report).toEqual({
      ok: false,
      at: "2026-08-21T10:00:00.000Z",
      reason: "could not reach http://localhost:9/v1: ECONNREFUSED",
    });
  });

  it("names a timeout as no answer in time", async () => {
    const timing: FetchLike = async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    };
    const report = await verifyEndpoint({
      endpoint: "http://localhost:9/v1",
      headers: {},
      fetchFn: timing,
      now,
    });
    expect(report).toMatchObject({
      ok: false,
      reason: "no answer from http://localhost:9/v1 in time",
    });
  });
});
