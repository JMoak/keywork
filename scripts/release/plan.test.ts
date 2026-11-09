import { describe, expect, it, vi } from "vitest";
import {
  latestReleaseTag,
  planRelease,
  type ReleaseRequest,
  type ReleaseTag,
  verifyPreviousPublication,
} from "./plan.ts";
import {
  confirmPublishedVersion,
  publishedVersion,
  verifyPublishedVersion,
} from "./publish-npm.ts";

const baseline: ReleaseTag = { name: "v0.2.2", sha: "baseline", reachable: true };

function request(
  messages: readonly string[],
  overrides: Partial<ReleaseRequest> = {},
): ReleaseRequest {
  return {
    refType: "branch",
    refName: "main",
    sha: "tested-head",
    tags: [baseline],
    commits: messages.map((message, index) => ({ hash: `${index}`.padStart(40, "0"), message })),
    ...overrides,
  };
}

describe("release planning", () => {
  it("waits for the authorized v0.2.2 baseline instead of bumping old feature history", async () => {
    expect(await planRelease(request(["feat: existing feature"], { tags: [] }))).toBeUndefined();
    expect(
      await planRelease(request([], { refType: "tag", refName: "v0.2.2", sha: baseline.sha })),
    ).toEqual({ version: "0.2.2", tag: "v0.2.2", sha: baseline.sha });
    await expect(
      planRelease(
        request([], {
          refType: "tag",
          refName: "v0.3.0",
          tags: [{ name: "v0.3.0", sha: "tested-head", reachable: true }],
        }),
      ),
    ).rejects.toThrow("v0.2.2 baseline");
  });

  it.each([
    ["fix: restore sessions", "0.2.3"],
    ["perf(engine): reduce latency", "0.2.3"],
    ["feat: add a command", "0.3.0"],
    ["feat!: replace a command", "1.0.0"],
    ["chore: change protocol\n\nBREAKING CHANGE: old clients cannot connect", "1.0.0"],
  ])("versions %s as %s", async (message, version) => {
    expect(await planRelease(request([message]))).toEqual({
      version,
      tag: `v${version}`,
      sha: "tested-head",
    });
  });

  it("skips maintenance and selects the highest release across all commits", async () => {
    expect(
      await planRelease(request(["docs: examples", "chore(deps): update tooling"])),
    ).toBeUndefined();
    expect(
      await planRelease(
        request([`Revert "fix: older release"\n\nThis reverts commit ${"a".repeat(40)}.`]),
      ),
    ).toBeUndefined();
    expect((await planRelease(request(["fix: bug", "feat: command"])))?.version).toBe("0.3.0");
  });

  it("excludes a feature reverted before its first release", async () => {
    expect(
      await planRelease(
        request([], {
          commits: [
            {
              hash: "b".repeat(40),
              message: `Revert "feat: temporary command"\n\nThis reverts commit ${"a".repeat(40)}.`,
            },
            { hash: "a".repeat(40), message: "feat: temporary command" },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("resumes a tag at the tested SHA instead of treating the rerun as no release", async () => {
    const tag = { name: "v0.3.0", sha: "tested-head", reachable: true };
    expect(await planRelease(request([], { tags: [baseline, tag] }))).toEqual({
      version: "0.3.0",
      tag: "v0.3.0",
      sha: "tested-head",
    });
    await expect(planRelease(request([], { refType: "tag", refName: "v0.2.2" }))).rejects.toThrow(
      "does not point to",
    );
  });

  it("does not release a stale queued commit behind a newer release", async () => {
    const later = { name: "v0.3.0", sha: "newer-head", reachable: false, ahead: true };
    expect(
      await planRelease(request(["fix: old change"], { tags: [baseline, later] })),
    ).toBeUndefined();
  });

  it("ignores unrelated branch tags but rejects a colliding release version", async () => {
    const unrelated = { name: "v1.0.0", sha: "other-branch", reachable: false };
    expect(
      (await planRelease(request(["fix: bug"], { tags: [baseline, unrelated] })))?.version,
    ).toBe("0.2.3");
    await expect(
      planRelease(request(["feat!: break compatibility"], { tags: [baseline, unrelated] })),
    ).rejects.toThrow("already belongs to another commit");
  });

  it("requires the preceding GitHub and npm publications before advancing", () => {
    const github = { tag_name: "v0.2.2", draft: false, prerelease: false };
    const npm = { name: "keywork-cli", version: "0.2.2", gitHead: "baseline" };
    expect(() => verifyPreviousPublication(baseline, github, npm, true)).not.toThrow();
    expect(() => verifyPreviousPublication(baseline, github, undefined, false)).not.toThrow();
    for (const prior of [undefined, { ...github, draft: true }, { ...github, prerelease: true }]) {
      expect(() => verifyPreviousPublication(baseline, prior, npm, true)).toThrow(
        "original release",
      );
    }
    expect(() => verifyPreviousPublication(baseline, github, undefined, true)).toThrow(
      "original release",
    );
    expect(() =>
      verifyPreviousPublication(baseline, github, { ...npm, gitHead: "other" }, true),
    ).toThrow("original release");
  });

  it("orders stable tags semantically and excludes prereleases", () => {
    expect(
      latestReleaseTag([
        baseline,
        { name: "v0.9.0", sha: "old", reachable: true },
        { name: "v0.10.0", sha: "new", reachable: true },
        { name: "v1.0.0-beta.1", sha: "beta", reachable: true },
      ])?.name,
    ).toBe("v0.10.0");
  });

  it("rejects a manual run from an unrelated branch", async () => {
    await expect(planRelease(request([], { refName: "feature" }))).rejects.toThrow("requires main");
  });
});

describe("npm release recovery", () => {
  it("accepts only the intended package, version and tested gitHead", () => {
    const manifest = { name: "keywork-cli", version: "0.2.2", gitHead: "tested-head" };
    expect(() => verifyPublishedVersion(manifest, "0.2.2", "tested-head")).not.toThrow();
    for (const other of [
      null,
      { ...manifest, gitHead: "other" },
      { ...manifest, version: "0.2.3" },
    ]) {
      expect(() => verifyPublishedVersion(other, "0.2.2", "tested-head")).toThrow("does not match");
    }
  });

  it("treats only a registry404 as an unpublished version", async () => {
    const lookup = (status: number) => vi.fn().mockResolvedValue(new Response("{}", { status }));
    expect(await publishedVersion("0.2.2", lookup(404))).toBeUndefined();
    for (const status of [401, 403, 429, 500]) {
      await expect(publishedVersion("0.2.2", lookup(status))).rejects.toThrow(`${status}`);
    }
    await expect(
      publishedVersion("0.2.2", vi.fn().mockRejectedValue(new Error("offline"))),
    ).rejects.toThrow("offline");
  });

  it("confirms a publication after bounded indexing retries", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ name: "keywork-cli", version: "0.2.2", gitHead: "tested-head" });
    const wait = vi.fn().mockResolvedValue(undefined);
    await confirmPublishedVersion("0.2.2", "tested-head", lookup, wait);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledWith(1000);

    lookup.mockReset().mockResolvedValue(undefined);
    await expect(confirmPublishedVersion("0.2.2", "tested-head", lookup, wait)).rejects.toThrow(
      "not indexed",
    );
    expect(lookup).toHaveBeenCalledTimes(15);
  });

  it("accepts a version indexed after the observed 55 second registry delay", async () => {
    let elapsed = 0;
    const manifest = { name: "keywork-cli", version: "0.2.2", gitHead: "tested-head" };
    const lookup = vi
      .fn()
      .mockImplementation(async () => (elapsed >= 55_000 ? manifest : undefined));
    const wait = vi.fn().mockImplementation(async (milliseconds: number) => {
      elapsed += milliseconds;
    });
    await confirmPublishedVersion("0.2.2", "tested-head", lookup, wait);
    expect(elapsed).toBe(55_000);
    expect(lookup).toHaveBeenCalledTimes(10);
    expect(wait).toHaveBeenCalledTimes(8);
  });

  it("waits for latest to catch up and reports an older channel after bounded retries", async () => {
    const manifest = { name: "keywork-cli", version: "0.2.2", gitHead: "tested-head" };
    const older = { name: "keywork-cli", version: "0.2.1" };
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce(older)
      .mockResolvedValue(manifest);
    const wait = vi.fn().mockResolvedValue(undefined);
    await confirmPublishedVersion("0.2.2", "tested-head", lookup, wait);
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(1);

    lookup
      .mockReset()
      .mockImplementation(async (version: string) => (version === "latest" ? older : manifest));
    wait.mockClear();
    await expect(confirmPublishedVersion("0.2.2", "tested-head", lookup, wait)).rejects.toThrow(
      "restore latest to 0.2.2 or newer",
    );
    expect(lookup).toHaveBeenCalledTimes(30);
    expect(wait).toHaveBeenCalledTimes(14);
    expect(wait.mock.calls.reduce((total, [milliseconds]) => total + milliseconds, 0)).toBe(
      115_000,
    );
  });

  it("accepts a newer latest without moving it backward", async () => {
    const lookup = vi
      .fn()
      .mockImplementation(async (version: string) =>
        version === "latest"
          ? { name: "keywork-cli", version: "0.3.0" }
          : { name: "keywork-cli", version: "0.2.2", gitHead: "tested-head" },
      );
    const wait = vi.fn().mockResolvedValue(undefined);
    await confirmPublishedVersion("0.2.2", "tested-head", lookup, wait);
    expect(lookup.mock.calls).toEqual([["0.2.2"], ["latest"]]);
    expect(wait).not.toHaveBeenCalled();
  });
});
