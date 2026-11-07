import { KeepAwake } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../engine/src/routines/testing.ts";
import {
  type ActivitySource,
  AwakeWhileLive,
  activityPollMs,
  workspaceActivity,
} from "./activity.ts";
import { settle } from "./testing.ts";

function countingInhibitor() {
  const held = { holds: 0, releases: 0 };
  return {
    held,
    inhibitor: {
      inhibit: () => {
        held.holds += 1;
        return () => {
          held.releases += 1;
        };
      },
    },
  };
}

function switchable(name: string): ActivitySource & { on: boolean } {
  const source = { name, on: false, live: async () => source.on };
  return source;
}

describe("keep-awake while a run is live", () => {
  it("holds the power assertion only while some source has a live run", async () => {
    const clock = new FakeClock(0);
    const { held, inhibitor } = countingInhibitor();
    const research = switchable("workspace:research");
    const changes: string[] = [];
    const awake = new AwakeWhileLive({
      awake: new KeepAwake(inhibitor),
      sources: [switchable("workspace:stead"), research],
      clock,
      onChange: (live, busy) => changes.push(live ? `hold ${busy.join(",")}` : "release"),
    });
    awake.start();
    await settle();
    expect(held).toEqual({ holds: 0, releases: 0 });
    research.on = true;
    await clock.advanceTo(activityPollMs, () => settle());
    expect(held).toEqual({ holds: 1, releases: 0 });
    await clock.advanceTo(2 * activityPollMs, () => settle());
    expect(held).toEqual({ holds: 1, releases: 0 });
    research.on = false;
    await clock.advanceTo(3 * activityPollMs, () => settle());
    expect(held).toEqual({ holds: 1, releases: 1 });
    expect(changes).toEqual(["hold workspace:research", "release"]);
    awake.stop();
    research.on = true;
    await clock.advanceTo(10 * activityPollMs, () => settle());
    expect(held).toEqual({ holds: 1, releases: 1 });
  });

  it("treats a source that cannot be read as idle", async () => {
    const { held, inhibitor } = countingInhibitor();
    const awake = new AwakeWhileLive({
      awake: new KeepAwake(inhibitor),
      sources: [{ name: "down", live: () => Promise.reject(new Error("ECONNREFUSED")) }],
      clock: new FakeClock(0),
    });
    expect(await awake.poll()).toBe(false);
    expect(held.holds).toBe(0);
    awake.stop();
  });

  it("releases the assertion when the node stops in the middle of a run", async () => {
    const { held, inhibitor } = countingInhibitor();
    const busy = switchable("workspace:stead");
    busy.on = true;
    const awake = new AwakeWhileLive({
      awake: new KeepAwake(inhibitor),
      sources: [busy],
      clock: new FakeClock(0),
    });
    await awake.poll();
    awake.stop();
    expect(held).toEqual({ holds: 1, releases: 1 });
  });
});

describe("workspaceActivity", () => {
  it("is live when the workspace's server lists a working session", async () => {
    const ticket = { url: "http://127.0.0.1:53111", token: "t" };
    const rows = [{ working: false }, { working: true }];
    const source = workspaceActivity(
      "workspace:stead",
      () => ticket,
      (held) => {
        expect(held).toBe(ticket);
        return { sessions: async () => rows };
      },
    );
    expect(await source.live()).toBe(true);
    rows[1] = { working: false };
    expect(await source.live()).toBe(false);
  });

  it("is idle when the workspace has no ticket", async () => {
    const source = workspaceActivity(
      "workspace:stead",
      () => undefined,
      () => {
        throw new Error("never asked");
      },
    );
    expect(await source.live()).toBe(false);
  });
});
