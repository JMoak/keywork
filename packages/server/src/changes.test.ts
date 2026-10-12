import { type ChangedPath, type EngineEvents, EventBus } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ChangesFeed, type ChangesSource, changesQuietMs } from "./changes.ts";
import { EventLog } from "./events.ts";

const quietWindow = () => new Promise((resolve) => setTimeout(resolve, changesQuietMs * 4));

function listing(changes: () => Promise<ChangedPath[]>): ChangesSource {
  return { label: "test", changes, before: async () => undefined, after: async () => undefined };
}

function countedListing(): { source: ChangesSource; listed: () => number } {
  let listed = 0;
  const source = listing(async () => {
    listed += 1;
    return [{ path: `file${listed}.ts`, added: 1, deleted: 0 }];
  });
  return { source, listed: () => listed };
}

function mutate(bus: EventBus<EngineEvents>, callId: string): void {
  bus.emit("tool.started", { call: { type: "tool-call", callId, name: "write", arguments: {} } });
  bus.emit("tool.finished", { callId, output: "", isError: false });
}

function updates(log: EventLog): Array<{ sessionId: string; payload: unknown }> {
  return log
    .since(0)
    .filter((envelope) => envelope.type === "changes.updated")
    .map(({ sessionId, payload }) => ({ sessionId, payload }));
}

describe("ChangesFeed", () => {
  it("announces once for a burst of mutating calls, then once more for the next burst", async () => {
    const log = new EventLog();
    const { source, listed } = countedListing();
    const feed = new ChangesFeed(log, async () => source);
    const bus = new EventBus<EngineEvents>();
    feed.follow(bus, "s1");
    for (const call of ["c1", "c2", "c3", "c4", "c5"]) mutate(bus, call);
    await quietWindow();
    expect(updates(log)).toEqual([{ sessionId: "s1", payload: { paths: ["file1.ts"] } }]);
    expect(listed()).toBe(1);
    mutate(bus, "c6");
    await quietWindow();
    expect(updates(log).map((update) => update.payload)).toEqual([
      { paths: ["file1.ts"] },
      { paths: ["file2.ts"] },
    ]);
  });

  it("folds mutations that land while a listing is in flight into one trailing announcement", async () => {
    const log = new EventLog();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listed = 0;
    const feed = new ChangesFeed(log, async () =>
      listing(async () => {
        listed += 1;
        if (listed === 1) await gate;
        return [];
      }),
    );
    const bus = new EventBus<EngineEvents>();
    feed.follow(bus, "s1");
    mutate(bus, "c1");
    await quietWindow();
    expect(listed).toBe(1);
    mutate(bus, "c2");
    mutate(bus, "c3");
    await quietWindow();
    release();
    await feed.settled();
    expect(updates(log)).toHaveLength(2);
    expect(listed).toBe(2);
  });

  it("keeps sessions apart and lets an explicit announcement stand in for a waiting one", async () => {
    const log = new EventLog();
    const { source } = countedListing();
    const feed = new ChangesFeed(log, async () => source);
    const first = new EventBus<EngineEvents>();
    const second = new EventBus<EngineEvents>();
    feed.follow(first, "a");
    feed.follow(second, "b");
    mutate(first, "c1");
    mutate(second, "c2");
    await feed.settled();
    expect(updates(log).map((update) => update.sessionId)).toEqual(["a", "b"]);
    mutate(first, "c3");
    await feed.announce("a");
    await quietWindow();
    expect(updates(log).map((update) => update.sessionId)).toEqual(["a", "b", "a"]);
  });

  it("stops announcing for a session once unfollowed", async () => {
    const log = new EventLog();
    const { source } = countedListing();
    const feed = new ChangesFeed(log, async () => source);
    const bus = new EventBus<EngineEvents>();
    const unfollow = feed.follow(bus, "s1");
    unfollow();
    mutate(bus, "c1");
    await quietWindow();
    expect(updates(log)).toEqual([]);
  });
});
