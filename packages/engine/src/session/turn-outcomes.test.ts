import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import { SessionStore } from "./store.ts";
import { recordTurnFacts, type TurnEnding } from "./turn-facts.ts";
import { outcomeMarksOf } from "./turn-outcomes.ts";

const tempDir = scratchDirs("keywork-turn-outcomes-");

describe("outcomeMarksOf", () => {
  it("marks each settled turn's prompt with how it ended, at its place in messages", async () => {
    const store = await freshStore();
    const first = await settledTurn(store, "first", "done", { outcome: "completed" });
    const second = await settledTurn(store, "second", "Starting to answer and then", {
      outcome: "failed",
      error: "upstream 529 overloaded",
    });
    const third = await settledTurn(store, "third", "half a", { outcome: "interrupted" });

    expect(store.messageMarks().outcomes).toEqual([
      { index: 0, entryId: first, outcome: "completed" },
      { index: 2, entryId: second, outcome: "failed", error: "upstream 529 overloaded" },
      { index: 4, entryId: third, outcome: "interrupted" },
    ]);
    expect(store.messages()[4]).toEqual(textMessage("user", "third"));
  });

  it("reads a prompt the engine never answered or settled as stopped by a shutdown", async () => {
    const store = await freshStore();
    await settledTurn(store, "first", "done", { outcome: "completed" });
    const orphan = await store.append(textMessage("user", "slow 300 100"));
    const after = await settledTurn(store, "next", "back", { outcome: "completed" });

    const reopened = await SessionStore.open(store.file);

    expect(reopened.messageMarks().outcomes.slice(1)).toEqual([
      { index: 2, entryId: orphan.id, outcome: "shutdown" },
      { index: 3, entryId: after, outcome: "completed" },
    ]);
  });

  it("leaves the running turn, a turn from before outcomes were kept, and a garbled one unmarked", async () => {
    const store = await freshStore();
    const old = await store.append(textMessage("user", "from an older release"));
    await store.append(textMessage("assistant", "answered"));
    await recordTurnFacts(store, { prompt: old.id, files: [] });
    await store.append(textMessage("user", "answered, never settled"));
    await store.append(textMessage("assistant", "a reply"));
    const garbled = await store.append(textMessage("user", "garbled"));
    await store.appendCustom("turn_facts", { prompt: garbled.id, files: [], outcome: "exploded" });
    await store.append(textMessage("user", "still running"));

    expect(outcomeMarksOf(store.activePath(), true)).toEqual([]);
  });
});

async function freshStore(): Promise<SessionStore> {
  return SessionStore.create(join(await tempDir(), "session.jsonl"), ".");
}

async function settledTurn(
  store: SessionStore,
  prompt: string,
  reply: string,
  ending: TurnEnding,
): Promise<string> {
  const entry = await store.append(textMessage("user", prompt));
  await store.append(textMessage("assistant", reply));
  await recordTurnFacts(store, { prompt: entry.id, files: [], ...ending });
  return entry.id;
}
