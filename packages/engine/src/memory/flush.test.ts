import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { messageText, textMessage } from "../messages.ts";
import { MockProvider, textTurn } from "../mock-provider.ts";
import { shouldCompact } from "../session/compaction.ts";
import { contextBudgetFor, readContext, reserveCaps } from "../session/context-budget.ts";
import {
  backtrackFlushClause,
  flushPrompt,
  isMemoryFlushPrompt,
  isNoReply,
  MemoryFlush,
  memoryFlushPrompt,
  noReplyToken,
  shouldFlush,
} from "./flush.ts";
import { memorySearchTool } from "./recall-tools.ts";
import { MemorySearch } from "./search.ts";
import { MemoryStore } from "./store.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

const contextWindow = 200_000;
const budget = contextBudgetFor(contextWindow);
const overThreshold = contextWindow - budget.flushReserve + 1;
const readingAt = (used: number) => readContext(used, budget);

async function openVault(trusted = true): Promise<{ store: MemoryStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "keywork-flush-"));
  cleanups.push(root);
  const store = new MemoryStore({
    vaultRoot: root,
    trusted,
    now: () => new Date("2026-08-10T14:30:00.000Z"),
  });
  return { store, root };
}

const longConversation = Array.from({ length: 40 }, (_, index) =>
  textMessage(index % 2 === 0 ? "user" : "assistant", `turn ${index} about the layout work`),
);

describe("shouldFlush", () => {
  it("fires at the reserve threshold, before compaction would", () => {
    expect(reserveCaps.flush).toBeGreaterThan(reserveCaps.compaction);
    expect(budget.flushReserve).toBe(reserveCaps.flush);
    expect(shouldFlush(readingAt(overThreshold))).toBe(true);
    expect(shouldCompact(readingAt(overThreshold))).toBe(false);
    expect(shouldFlush(readingAt(contextWindow - budget.flushReserve))).toBe(false);
  });
});

describe("MemoryFlush", () => {
  it("flushes a long conversation to the daily log and the fact survives into a new session", async () => {
    const { store, root } = await openVault();
    const flush = new MemoryFlush({
      provider: new MockProvider([
        textTurn("Split ratios were decided 60/40 after the resize review."),
      ]),
      store,
    });
    const outcome = await flush.maybeFlush(longConversation, readingAt(overThreshold));
    expect(outcome).toMatchObject({ flushed: true, persisted: true });
    const daily = await readFile(join(root, "daily", "2026-08-10.md"), "utf8");
    expect(daily).toContain(
      "- 14:30 [prov: agent] Split ratios were decided 60/40 after the resize review.",
    );

    const fresh = new MemoryStore({ vaultRoot: root, trusted: true });
    const recall = await memorySearchTool(fresh, new MemorySearch(fresh)).execute({
      query: "split ratios decided",
    });
    expect(recall).toContain("Split ratios were decided 60/40");
  });

  it("asks about wrongness and instructs a NO_REPLY escape in the flush prompt", () => {
    expect(memoryFlushPrompt).toContain("proved wrong");
    expect(memoryFlushPrompt).toContain("supersedes");
    expect(memoryFlushPrompt).toContain(noReplyToken);
    expect(isMemoryFlushPrompt(memoryFlushPrompt)).toBe(true);
    expect(isMemoryFlushPrompt("something else")).toBe(false);
  });

  it("records the silent turn for honest replay while marking NO_REPLY as unrenderable", async () => {
    const { store, root } = await openVault();
    const flush = new MemoryFlush({
      provider: new MockProvider([textTurn(`  ${noReplyToken}\n`)]),
      store,
    });
    const outcome = await flush.maybeFlush(longConversation, readingAt(overThreshold));
    expect(outcome.flushed).toBe(true);
    expect(outcome.persisted).toBe(false);
    expect(outcome.messages).toHaveLength(2);
    const [prompt, reply] = outcome.messages;
    expect(prompt === undefined ? "" : messageText(prompt)).toBe(memoryFlushPrompt);
    expect(reply !== undefined && isNoReply(reply)).toBe(true);
    await expect(readFile(join(root, "daily", "2026-08-10.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fires exactly once, then again only after compaction completes", async () => {
    const { store } = await openVault();
    const flush = new MemoryFlush({
      provider: new MockProvider([textTurn("first fact"), textTurn("second fact")]),
      store,
    });
    const first = await flush.maybeFlush(longConversation, readingAt(overThreshold));
    expect(first.flushed).toBe(true);
    const latched = await flush.maybeFlush(longConversation, readingAt(overThreshold));
    expect(latched).toEqual({ flushed: false, persisted: false, messages: [] });
    flush.compactionCompleted();
    const second = await flush.maybeFlush(longConversation, readingAt(overThreshold));
    expect(second.flushed).toBe(true);
    expect((await store.readDaily("2026-08-10")).map((entry) => entry.text)).toEqual([
      "first fact",
      "second fact",
    ]);
  });

  it("stays quiet below the threshold without touching the provider", async () => {
    const { store } = await openVault();
    const flush = new MemoryFlush({ provider: new MockProvider([]), store });
    const outcome = await flush.maybeFlush(longConversation, readingAt(1000));
    expect(outcome).toEqual({ flushed: false, persisted: false, messages: [] });
  });

  it("is inert over an untrusted vault: no turn, no writes", async () => {
    const { store } = await openVault(false);
    const flush = new MemoryFlush({ provider: new MockProvider([]), store });
    const outcome = await flush.maybeFlush(longConversation, readingAt(overThreshold));
    expect(outcome).toEqual({ flushed: false, persisted: false, messages: [] });
  });

  it("treats an empty reply like NO_REPLY", async () => {
    const { store } = await openVault();
    const flush = new MemoryFlush({ provider: new MockProvider([textTurn("   \n")]), store });
    const outcome = await flush.maybeFlush(longConversation, readingAt(overThreshold));
    expect(outcome.persisted).toBe(false);
    expect(await store.readDaily("2026-08-10")).toEqual([]);
  });
});

describe("backtrack capture", () => {
  it("asks about abandoned attempts and lands the answer in the arc daily log", async () => {
    const { store } = await openVault();
    const arc = await openVault();
    const flush = new MemoryFlush({
      provider: new MockProvider([
        textTurn("Tried CSS grid for the dock; it broke resize, flexbox is the way."),
      ]),
      store,
      dailyStore: () => arc.store,
    });
    flush.noteBacktrack();

    const outcome = await flush.maybeFlush(longConversation, readingAt(overThreshold));

    expect(outcome.persisted).toBe(true);
    expect(messageText(outcome.messages[0] ?? textMessage("user", ""))).toContain(
      backtrackFlushClause,
    );
    const arcDaily = await readFile(join(arc.root, "daily", "2026-08-10.md"), "utf8");
    expect(arcDaily).toContain("[prov: agent] Tried CSS grid for the dock");
    await expect(
      readFile(join((await openVault()).root, "daily", "2026-08-10.md")),
    ).rejects.toThrow();
  });

  it("captures to the workspace daily when the session is unbound", async () => {
    const { store, root } = await openVault();
    const flush = new MemoryFlush({
      provider: new MockProvider([textTurn("Abandoned the sed approach, quoting was hopeless.")]),
      store,
    });
    flush.noteBacktrack();

    await flush.maybeFlush(longConversation, readingAt(overThreshold));

    const daily = await readFile(join(root, "daily", "2026-08-10.md"), "utf8");
    expect(daily).toContain("[prov: agent] Abandoned the sed approach");
  });

  it("keeps the ordinary prompt when nothing was backtracked, and clears the clause after a flush", async () => {
    const { store } = await openVault();
    const flush = new MemoryFlush({
      provider: new MockProvider([textTurn("First."), textTurn("Second.")]),
      store,
    });
    flush.noteBacktrack();
    const first = await flush.maybeFlush(longConversation, readingAt(overThreshold));
    flush.compactionCompleted();
    const second = await flush.maybeFlush(longConversation, readingAt(overThreshold));

    expect(messageText(first.messages[0] ?? textMessage("user", ""))).toContain(
      backtrackFlushClause,
    );
    expect(messageText(second.messages[0] ?? textMessage("user", ""))).toBe(memoryFlushPrompt);
  });

  it("recognizes both prompt forms", () => {
    expect(isMemoryFlushPrompt(flushPrompt(true))).toBe(true);
    expect(isMemoryFlushPrompt(flushPrompt(false))).toBe(true);
  });
});
