import { describe, expect, it, vi } from "vitest";
import { readGithubRelease } from "./github-release.ts";

const draft = { tag_name: "v0.2.2", draft: true, prerelease: false };
const published = { ...draft, draft: false };

describe("GitHub release lookup", () => {
  it("returns a published tag without listing releases", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(published));
    expect(await readGithubRelease("tags/v0.2.2", request)).toEqual(published);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("finds the matching draft when the published tag endpoint returns 404", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json([{ ...published, tag_name: "v0.2.1" }, draft]));
    expect(await readGithubRelease("tags/v0.2.2", request)).toEqual(draft);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/JMoak/keywork/releases/tags/v0.2.2",
      "https://api.github.com/repos/JMoak/keywork/releases?per_page=100&page=1",
    ]);
  });

  it("continues through complete pages to find an older draft", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      ...published,
      tag_name: `v1.0.${index}`,
    }));
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(Response.json([draft]));
    expect(await readGithubRelease("tags/v0.2.2", request)).toEqual(draft);
    expect(request.mock.calls[2]?.[0]).toBe(
      "https://api.github.com/repos/JMoak/keywork/releases?per_page=100&page=2",
    );
  });

  it("returns absent only after a successful listing has no matching tag", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json([{ ...published, tag_name: "v0.2.1" }]));
    expect(await readGithubRelease("tags/v0.2.2", request)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never substitutes a draft for a missing latest release", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    expect(await readGithubRelease("latest", request)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 500])("propagates a tag lookup failure with status %s", async (status) => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status }));
    await expect(readGithubRelease("tags/v0.2.2", request)).rejects.toThrow(`${status}`);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 500])(
    "propagates a draft listing failure with status %s",
    async (status) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status }));
      await expect(readGithubRelease("tags/v0.2.2", request)).rejects.toThrow(`${status}`);
    },
  );

  it("does not treat a failed connection as a missing release", async () => {
    const request = vi.fn().mockRejectedValue(new Error("connection failed"));
    await expect(readGithubRelease("tags/v0.2.2", request)).rejects.toThrow("connection failed");
  });

  it("rejects an invalid draft listing instead of assuming the tag is absent", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ message: "unexpected result" }));
    await expect(readGithubRelease("tags/v0.2.2", request)).rejects.toThrow(
      "invalid release listing",
    );
  });
});
