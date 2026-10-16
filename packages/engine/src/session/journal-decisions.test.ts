import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { type EngineEvents, EventBus } from "../bus.ts";
import type { MemoryDecision } from "../memory/decider.ts";
import { textMessage } from "../messages.ts";
import { journalEvents, tapJournal } from "./journal.ts";
import { replaySession } from "./replay.ts";
import { SessionStore } from "./store.ts";

const tempDir = scratchDirs("keywork-journal-decisions-");

const decision: MemoryDecision = {
  id: "d1",
  question: "action-relevance@1",
  about: { kind: "call", callId: "call-1" },
  candidates: ["Dock Rule", "Old Rule"],
  choice: { kept: ["Dock Rule"], dropped: ["Old Rule"] },
  decider: "builtin",
  rule: '[[Dock Rule]] shares "dock" with the path; [[Old Rule]] is superseded',
  latencyMs: 0,
};

async function sessionWithADecisionBehindCompaction(): Promise<{ file: string }> {
  const file = join(await tempDir(), "session.jsonl");
  const store = await SessionStore.create(file, "/work");
  const bus = new EventBus<EngineEvents>();
  const tap = tapJournal(bus, store);
  await store.append(textMessage("user", "edit the dock"));
  bus.emit("memory.decided", { decision });
  bus.emit("context.injected", {
    injection: { source: "memory-action", id: "Dock Rule", scope: "workspace" },
  });
  await tap.flush();
  const kept = await store.append(textMessage("assistant", "edited"));
  await store.appendCompaction({
    summary: "the dock was edited",
    firstKeptEntryId: kept.id,
    tokensBefore: 4000,
  });
  tap.stop();
  return { file };
}

describe("memory decisions on the session journal", () => {
  it("writes each decision as a greppable memory_decision entry", async () => {
    const { file } = await sessionWithADecisionBehindCompaction();

    const raw = await readFile(file, "utf8");
    const reopened = await SessionStore.open(file);

    expect(raw).toContain('"customType":"memory_decision"');
    expect(journalEvents(reopened.entries())).toContainEqual({
      type: "memory_decision",
      decision,
    });
  });

  it("re-emits the decision with replay set, in order before the injection it caused", async () => {
    const { file } = await sessionWithADecisionBehindCompaction();
    const reopened = await SessionStore.open(file);
    const bus = new EventBus<EngineEvents>();
    const seen: string[] = [];
    bus.on("memory.decided", ({ decision: replayed, replay }) => {
      expect(replay).toBe(true);
      expect(replayed).toEqual(decision);
      seen.push("decided");
    });
    bus.on("context.injected", ({ injection }) => seen.push(`injected ${injection.id}`));

    replaySession(reopened, bus);

    expect(seen).toEqual(["decided", "injected Dock Rule"]);
  });

  it("never re-appends a replayed decision", async () => {
    const store = await SessionStore.create(join(await tempDir(), "session.jsonl"), "/work");
    const bus = new EventBus<EngineEvents>();
    const tap = tapJournal(bus, store);

    bus.emit("memory.decided", { decision, replay: true });
    await tap.flush();
    tap.stop();

    expect(store.entries()).toHaveLength(0);
  });
});
