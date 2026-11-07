import { describe, expect, it } from "vitest";
import { FakeCreatureSessions } from "./testing.ts";
import { CreatureThreads, threadStateOf, threadSummaryOf } from "./threads.ts";

describe("the conversation", () => {
  it("is opened lazily, once, bound to the creature, and found again afterwards", async () => {
    const sessions = new FakeCreatureSessions();
    const threads = new CreatureThreads(sessions);
    expect(await threads.conversationOf("pip")).toBeUndefined();
    const [first, second] = await Promise.all([
      threads.conversationFor("pip"),
      threads.conversationFor("pip"),
    ]);
    expect(first).toBe("s1");
    expect(second).toBe("s1");
    expect(await threads.conversationFor("pip")).toBe("s1");
    expect(sessions.opened).toEqual([{ creature: "pip", kind: "conversation" }]);
    expect(await threads.conversationOf("pip")).toBe("s1");
  });

  it("is the oldest session carrying the tag when a fork duplicated it", async () => {
    const sessions = new FakeCreatureSessions();
    sessions.add(
      { creature: "pip", kind: "conversation" },
      { id: "fork", createdAt: "2026-11-05T10:00:00.000Z" },
    );
    sessions.add(
      { creature: "pip", kind: "conversation" },
      { id: "root", createdAt: "2026-11-05T08:00:00.000Z" },
    );
    const threads = new CreatureThreads(sessions);
    expect(await threads.conversationFor("pip")).toBe("root");
    expect(sessions.opened).toEqual([]);
  });

  it("is known per creature for the guard that keeps it out of the trash", async () => {
    const sessions = new FakeCreatureSessions();
    sessions.add({ creature: "pip", kind: "conversation" }, { id: "pip-c" });
    sessions.add({ creature: "pip", kind: "thread" }, { id: "pip-t" });
    sessions.add({ creature: "mo", kind: "conversation" }, { id: "mo-c" });
    expect([...(await new CreatureThreads(sessions).conversations())].sort()).toEqual([
      "mo-c",
      "pip-c",
    ]);
  });
});

describe("threads", () => {
  it("lists a creature's threads newest first with their state, children rolled up", async () => {
    const sessions = new FakeCreatureSessions();
    sessions.add({ creature: "pip", kind: "conversation" }, { id: "c" });
    sessions.add(
      { creature: "pip", kind: "thread" },
      { id: "t1", title: "fix the build", working: true },
    );
    sessions.add({ creature: "pip", kind: "routine" }, { id: "r1", title: "triage", waiting: 2 });
    sessions.add(
      { creature: "pip", kind: "thread" },
      { id: "t2", title: "stuck", held: "blocked" },
    );
    sessions.add({ creature: "pip", kind: "child" }, { id: "k1", parent: "t1" });
    sessions.add({ creature: "pip", kind: "child" }, { id: "k2", parent: "t1" });
    sessions.add({ creature: "mo", kind: "thread" }, { id: "other" });
    const threads = await new CreatureThreads(sessions).threadsOf("pip");
    expect(threads.map((thread) => thread.id)).toEqual(["t2", "r1", "t1"]);
    expect(threads.map((thread) => [thread.kind, thread.state, thread.children])).toEqual([
      ["thread", "blocked", 0],
      ["routine", "waiting", 0],
      ["thread", "working", 2],
    ]);
  });

  it("opens a thread tagged with the creature and its kind", async () => {
    const sessions = new FakeCreatureSessions();
    const id = await new CreatureThreads(sessions).openThread("pip", "routine");
    expect(id).toBe("s1");
    expect(sessions.opened).toEqual([{ creature: "pip", kind: "routine" }]);
  });

  it.each([
    [{ working: true, waiting: 0 }, "working"],
    [{ working: true, waiting: 1 }, "waiting"],
    [{ working: false, waiting: 0 }, "back"],
    [{ working: true, waiting: 0, held: "blocked" as const }, "blocked"],
    [{ working: false, waiting: 0, held: "paused" as const }, "paused"],
  ])("reads the state of %j as %s", (facts, state) => {
    expect(threadStateOf(facts)).toBe(state);
  });
});

describe("reporting a finished thread", () => {
  it("lands in the conversation as one summary entry per thread, in finish order, with a creature origin", async () => {
    const sessions = new FakeCreatureSessions();
    const threads = new CreatureThreads(sessions);
    const a = await threads.openThread("pip", "thread");
    const b = await threads.openThread("pip", "routine");
    expect(
      await threads.finish("pip", a, {
        title: "fix the build",
        outcome: "completed",
        summary: "tests green",
      }),
    ).toBe("noted");
    expect(
      await threads.finish("pip", b, {
        title: "triage",
        outcome: "failed",
        summary: "inbox unreachable",
      }),
    ).toBe("noted");
    const conversation = await threads.conversationOf("pip");
    expect(conversation).toBe("s3");
    expect(sessions.injections.map((injection) => injection.origin)).toEqual([
      { kind: "creature", creature: "pip", thread: a },
      { kind: "creature", creature: "pip", thread: b },
    ]);
    expect(sessions.transcripts.get("s3")).toEqual([
      'Thread "fix the build" finished: tests green',
      'Thread "triage" failed: inbox unreachable',
    ]);
    expect(sessions.turnsStarted("s3")).toBe(0);
  });

  it("lands each summary as an entry while a conversation turn runs, starts no turn, and never interleaves thread activity", async () => {
    const sessions = new FakeCreatureSessions();
    const threads = new CreatureThreads(sessions);
    const conversation = await threads.conversationFor("pip");
    const a = await threads.openThread("pip", "thread");
    const b = await threads.openThread("pip", "thread");
    sessions.startTurn(conversation);
    sessions.write(a, "reading src/a.ts");
    sessions.write(b, "running tests");
    expect(
      await threads.finish("pip", a, { title: "a", outcome: "completed", summary: "done a" }),
    ).toBe("noted");
    sessions.write(b, "tests passed");
    expect(
      await threads.finish("pip", b, { title: "b", outcome: "completed", summary: "done b" }),
    ).toBe("noted");
    sessions.settle(conversation);
    expect(sessions.turnsStarted(conversation)).toBe(1);
    expect(sessions.transcripts.get(conversation)).toEqual([
      'Thread "a" finished: done a',
      'Thread "b" finished: done b',
    ]);
    expect(sessions.transcripts.get(a)).toEqual(["reading src/a.ts"]);
    expect(sessions.transcripts.get(b)).toEqual(["running tests", "tests passed"]);
  });

  it("writes one line whatever the thread said", () => {
    expect(
      threadSummaryOf({
        title: "  fix\nthe build ",
        outcome: "interrupted",
        summary: "stopped\n\n  halfway\tthrough",
      }),
    ).toBe('Thread "fix the build" was interrupted: stopped halfway through');
    expect(threadSummaryOf({ title: "triage", outcome: "blocked", summary: "" })).toBe(
      'Thread "triage" is blocked.',
    );
  });
});
