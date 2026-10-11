import { join } from "node:path";
import { MockProvider, SessionStore } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { closingSeamFor, latestArcActivity } from "./arc-seams.ts";

const tempDir = scratchDirs("keywork-arc-seams-");

describe("the closing seam shared by panes and serve", () => {
  it("builds a closing judgment over the arc's provider, steered by the request, and nothing without one", () => {
    const degraded: string[] = [];
    const request = {
      arc: "alpha",
      direction: "keep the rules",
      onDegrade: (reason: string) => degraded.push(reason),
    };
    const seamed = closingSeamFor((arc) => (arc === "alpha" ? new MockProvider([]) : undefined));
    expect(seamed(request)?.id).toBe("closing:mock");
    expect(seamed({ ...request, arc: "beta" })).toBeUndefined();
    expect(degraded).toEqual([]);
  });
});

describe("the latest activity of an arc's sessions", () => {
  it("answers the newest bound session's last activity and nothing for an arc without sessions", async () => {
    const dir = await tempDir();
    const older = await SessionStore.create(join(dir, "1-0001-1.jsonl"), dir);
    await older.appendArcBinding("alpha");
    await older.append({ role: "user", parts: [{ type: "text", text: "first" }] });
    const newer = await SessionStore.create(join(dir, "2-0001-2.jsonl"), dir);
    await newer.appendArcBinding("alpha");
    await newer.append({ role: "user", parts: [{ type: "text", text: "second" }] });
    const elsewhere = await SessionStore.create(join(dir, "3-0001-3.jsonl"), dir);
    await elsewhere.appendArcBinding("beta");
    await elsewhere.append({ role: "user", parts: [{ type: "text", text: "third" }] });

    const latest = await latestArcActivity(dir, "alpha");
    expect(latest).toBeDefined();
    expect(latest).toBe(newer.stats().lastActivityAt);
    expect(await latestArcActivity(dir, "gamma")).toBeUndefined();
  });
});
