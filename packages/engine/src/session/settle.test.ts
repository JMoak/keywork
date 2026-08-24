import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFlush } from "../memory/flush.ts";
import { MemoryStore } from "../memory/store.ts";
import { messageText, textMessage } from "../messages.ts";
import { MockProvider, textTurn } from "../mock-provider.ts";
import { contextBudgetFor } from "./context-budget.ts";
import { compactNow, readStore, settleTurn } from "./settle.ts";
import { SessionStore } from "./store.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-settle-"));
  tempDirs.push(dir);
  return dir;
}

async function sessionOf(turns: number, width = 200): Promise<SessionStore> {
  const store = await SessionStore.create(join(await tempDir(), "session.jsonl"), ".");
  for (let turn = 1; turn <= turns; turn += 1) {
    await store.append(textMessage("user", `question ${turn} ${"q".repeat(width)}`));
    await store.append(textMessage("assistant", `answer ${turn} ${"a".repeat(width)}`));
  }
  return store;
}

async function trustedVault(): Promise<MemoryStore> {
  return new MemoryStore({ vaultRoot: await tempDir(), trusted: true });
}

describe("settleTurn", () => {
  it("leaves a roomy context alone", async () => {
    const store = await sessionOf(2);
    const provider = new MockProvider([]);
    const settlement = await settleTurn({
      store,
      provider,
      history: store.messages(),
      budget: contextBudgetFor(200_000),
    });
    expect(settlement).toEqual({
      history: undefined,
      notices: [],
      flushed: [],
      compacted: undefined,
    });
    expect(provider.remaining()).toBe(0);
  });

  it("compacts past the mark, re-arms the flush latch, and hands back the compacted history", async () => {
    const store = await sessionOf(6);
    const budget = contextBudgetFor(500);
    expect(readStore(store, budget).used).toBeGreaterThan(budget.window);
    const flush = new MemoryFlush({
      provider: new MockProvider([textTurn("fact one"), textTurn("fact two")]),
      store: await trustedVault(),
    });
    const provider = new MockProvider([textTurn("## Goal\nsummary")]);

    const settlement = await settleTurn({
      store,
      provider,
      history: store.messages(),
      budget,
      flush,
    });

    expect(settlement.compacted?.summary).toBe("## Goal\nsummary");
    expect(settlement.flushed.map(messageText)).toEqual([
      expect.stringContaining("Context is nearly full"),
      "fact one",
    ]);
    expect(settlement.history).toEqual(store.messages());
    expect(messageText(settlement.history?.[0] ?? textMessage("user", ""))).toBe(
      "## Goal\nsummary",
    );
    expect(settlement.notices).toEqual([
      expect.stringMatching(/^compacted \d+(\.\d)?k? tokens into a summary · context now /),
    ]);
    expect(readStore(store, budget).used).toBeLessThan(budget.window);

    await store.append(textMessage("user", `later ${"z".repeat(1_800)}`));
    const again = await settleTurn({
      store,
      provider: new MockProvider([textTurn("## Goal\nsecond summary")]),
      history: store.messages(),
      budget,
      flush,
    });
    expect(again.flushed.map(messageText).at(-1)).toBe("fact two");
    expect(again.compacted?.summary).toBe("## Goal\nsecond summary");
  });

  it("flushes without compacting when only the flush mark is crossed", async () => {
    const store = await sessionOf(4, 100);
    const used = readStore(store, contextBudgetFor(200_000)).used;
    const window = Math.round(used / (1 - 1 / 8 + 0.01));
    const budget = contextBudgetFor(window);
    expect(used).toBeGreaterThan(budget.window - budget.flushReserve);
    const flush = new MemoryFlush({
      provider: new MockProvider([textTurn("NO_REPLY")]),
      store: await trustedVault(),
    });

    const settlement = await settleTurn({
      store,
      provider: new MockProvider([]),
      history: store.messages(),
      budget,
      flush,
    });

    expect(settlement.compacted).toBeUndefined();
    expect(settlement.flushed).toHaveLength(2);
    expect(settlement.history).toHaveLength(store.messages().length);
    expect(store.messages()).toHaveLength(10);
  });

  it("reports a failed flush as a notice and still finishes the turn", async () => {
    const store = await sessionOf(4, 100);
    const used = readStore(store, contextBudgetFor(200_000)).used;
    const budget = contextBudgetFor(Math.round(used / (1 - 1 / 8 + 0.01)));
    const flush = new MemoryFlush({
      provider: {
        name: "broken",
        stream: () => {
          throw new Error("vault offline");
        },
      },
      store: await trustedVault(),
    });

    const settlement = await settleTurn({
      store,
      provider: new MockProvider([]),
      history: store.messages(),
      budget,
      flush,
    });

    expect(settlement.notices).toEqual(["flush failed: vault offline"]);
    expect(settlement.flushed).toEqual([]);
    expect(settlement.history).toBeUndefined();
    expect(settlement.compacted).toBeUndefined();
  });

  it("reports a failed compaction and keeps the history intact", async () => {
    const store = await sessionOf(6);
    const provider = new MockProvider([textTurn("   ")]);
    const settlement = await settleTurn({
      store,
      provider,
      history: store.messages(),
      budget: contextBudgetFor(500),
    });
    expect(settlement.history).toBeUndefined();
    expect(settlement.notices).toEqual(["compaction failed: compaction produced an empty summary"]);
    expect(store.messages()).toHaveLength(12);
  });

  it("stays silent when the context is over the mark but nothing is old enough to fold", async () => {
    const store = await SessionStore.create(join(await tempDir(), "session.jsonl"), ".");
    await store.append(textMessage("user", `one long question ${"q".repeat(4_000)}`));
    const settlement = await settleTurn({
      store,
      provider: new MockProvider([]),
      history: store.messages(),
      budget: contextBudgetFor(500),
    });
    expect(settlement.history).toBeUndefined();
    expect(settlement.notices).toEqual([]);
  });
});

describe("compactNow", () => {
  it("folds on request with instructions and reports the result", async () => {
    const store = await sessionOf(6);
    const provider = new MockProvider([textTurn("focused summary")]);
    const settlement = await compactNow({
      store,
      provider,
      budget: contextBudgetFor(2_000),
      instructions: "keep the file names",
    });
    expect(settlement.compacted?.summary).toBe("focused summary");
    expect(settlement.history?.length).toBeLessThan(12);
    expect(settlement.notices[0]).toMatch(/^compacted /);
  });

  it("folds twice in a row into one summary at the front, in chronological order", async () => {
    const store = await sessionOf(8);
    const budget = contextBudgetFor(200_000);

    await compactNow({ store, provider: new MockProvider([textTurn("SUMMARY-ONE")]), budget });
    await compactNow({ store, provider: new MockProvider([textTurn("SUMMARY-TWO")]), budget });

    const heads = store
      .messages()
      .map((message) => /^(SUMMARY-\w+|question \d+|answer \d+)/.exec(messageText(message))?.[0]);
    expect(heads.filter((head) => head?.startsWith("SUMMARY"))).toEqual(["SUMMARY-TWO"]);
    expect(heads[0]).toBe("SUMMARY-TWO");
    const chronological = Array.from({ length: 8 }, (_, index) => [
      `question ${index + 1}`,
      `answer ${index + 1}`,
    ]).flat();
    const tail = heads.slice(1);
    expect(tail).toEqual(chronological.slice(chronological.length - tail.length));
    expect((await SessionStore.open(store.file)).messages()).toEqual(store.messages());
  });

  it("says so when there is nothing to fold yet", async () => {
    const store = await SessionStore.create(join(await tempDir(), "session.jsonl"), ".");
    await store.append(textMessage("user", "hi"));
    const settlement = await compactNow({
      store,
      provider: new MockProvider([]),
      budget: contextBudgetFor(200_000),
    });
    expect(settlement).toEqual({
      history: undefined,
      notices: ["nothing to compact yet · the recent turns are all that's here"],
      flushed: [],
      compacted: undefined,
    });
  });
});
