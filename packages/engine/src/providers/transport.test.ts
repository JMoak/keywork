import { describe, expect, it } from "vitest";
import { ProviderEmptyResponseError, ProviderHttpError } from "./errors.ts";
import { type FetchLike, postForStream } from "./transport.ts";

const post = { url: "https://example.test/v1/chat", headers: { a: "b" }, body: "{}" };

describe("postForStream", () => {
  it("POSTs the body with the given headers and hands back the response stream", async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      seen = { url, init };
      return new Response("payload", { status: 200 });
    };
    const controller = new AbortController();

    const stream = await postForStream("test", fetchFn, { ...post, signal: controller.signal });

    expect(await new Response(stream).text()).toBe("payload");
    expect(seen?.url).toBe(post.url);
    expect(seen?.init).toMatchObject({ method: "POST", headers: { a: "b" }, body: "{}" });
    expect(seen?.init?.signal).toBe(controller.signal);
  });

  it("turns a failing status into ProviderHttpError carrying the body and Retry-After", async () => {
    const fetchFn: FetchLike = async () =>
      new Response("slow down", { status: 429, headers: { "retry-after": "7" } });

    const failure = await postForStream("test", fetchFn, post).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect(failure).toMatchObject({ status: 429, retryAfter: "7" });
    expect((failure as Error).message).toMatch(/429.*slow down/s);
  });

  it("fails with a typed transient error when the response has no body", async () => {
    const failure = await postForStream(
      "test",
      async () => new Response(null, { status: 200 }),
      post,
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ProviderEmptyResponseError);
    expect(failure).toMatchObject({ transient: true });
    expect((failure as Error).message).toBe("test returned an empty response body");
  });
});
