import { describe, expect, it, vi } from "vitest";
import { EndpointUnreachableError, probeHttp } from "./http.ts";

describe("loopback model probes", () => {
  it("keeps local metadata and explicit tool checks from following redirects off the chosen endpoint", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const http = probeHttp({ fetchFn });
    await http.get("http://localhost:1234/api/v1/models");
    await http.post("http://127.0.0.1:1234/v1/chat/completions", { model: "chosen" });
    await http.get("http://[::1]:1234/api/v1/models");
    expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const call of fetchFn.mock.calls)
      expect(call).toEqual([expect.any(String), expect.objectContaining({ redirect: "error" })]);
  });

  it("reports a refused redirect as an unreachable endpoint instead of succeeding", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed: redirect disallowed");
    });
    await expect(
      probeHttp({ fetchFn }).get("http://localhost:1234/api/v1/models"),
    ).rejects.toBeInstanceOf(EndpointUnreachableError);
  });
});
