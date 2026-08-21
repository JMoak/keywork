import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Message, messageText, textMessage } from "../messages.ts";
import { MockProvider, textTurn } from "../mock-provider.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import {
  compactionSettingsFor,
  compactSession,
  planCompaction,
  serializeConversation,
  shouldCompact,
} from "./compaction.ts";
import { contextBudgetFor, readContext } from "./context-budget.ts";
import { SessionStore } from "./store.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-compaction-"));
  tempDirs.push(dir);
  return join(dir, "session.jsonl");
}

async function longSession(): Promise<SessionStore> {
  const store = await SessionStore.create(await sessionFile(), ".");
  for (let turn = 1; turn <= 4; turn++) {
    await store.append(textMessage("user", `question ${turn} ${"x".repeat(200)}`));
    await store.append(
      {
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            callId: `c${turn}`,
            name: "read",
            arguments: { path: `f${turn}.ts` },
          },
        ],
      },
      { inputTokens: 10, outputTokens: 5 },
    );
    await store.append({
      role: "tool",
      parts: [{ type: "tool-result", callId: `c${turn}`, output: "contents", isError: false }],
    });
    await store.append(textMessage("assistant", `answer ${turn} ${"y".repeat(200)}`));
  }
  return store;
}

const tinyBudget = { reserveTokens: 10, keepRecentTokens: 60 };

describe("shouldCompact", () => {
  it("triggers once the reading passes the compaction mark", () => {
    const budget = contextBudgetFor(100_000);
    expect(budget.compactionReserve).toBe(8_333);
    expect(shouldCompact(readContext(100_000 - 8_333 + 1, budget))).toBe(true);
    expect(shouldCompact(readContext(100_000 - 8_333, budget))).toBe(false);
  });

  it("derives the plan settings from the budget", () => {
    expect(compactionSettingsFor(contextBudgetFor(8_000))).toEqual({
      reserveTokens: 666,
      keepRecentTokens: 800,
    });
  });
});

describe("planCompaction", () => {
  it("cuts at a message boundary, never at a tool result", async () => {
    const store = await longSession();

    const plan = planCompaction(store, tinyBudget);

    expect(plan).toBeDefined();
    const kept = store.entry(plan?.firstKeptEntryId ?? "");
    expect(kept?.type).toBe("message");
    const role = kept?.type === "message" ? kept.message.role : undefined;
    expect(["user", "assistant"]).toContain(role);
    expect(plan?.entriesToSummarize.length).toBeGreaterThan(0);
    expect(plan?.tokensBefore).toBeGreaterThan(0);
  });

  it("declines when there is nothing worth summarizing", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    await store.append(textMessage("user", "hi"));

    expect(planCompaction(store, tinyBudget)).toBeUndefined();
  });
});

describe("compactSession", () => {
  it("writes a compaction entry and serves summary plus kept tail", async () => {
    const store = await longSession();
    const provider = new MockProvider([
      textTurn("## Goal\ncompacted", { inputTokens: 50, outputTokens: 9 }),
    ]);

    const entry = await compactSession(store, provider, { settings: tinyBudget });

    expect(entry?.summary).toBe("## Goal\ncompacted");
    expect(entry?.usage).toEqual({ inputTokens: 50, outputTokens: 9 });
    expect(entry?.details?.readFiles.length).toBeGreaterThan(0);

    const texts = store.messages().map(messageText);
    expect(texts[0]).toBe("## Goal\ncompacted");
    expect(texts).not.toContain(`question 1 ${"x".repeat(200)}`);
    expect(texts.at(-1)).toBe(`answer 4 ${"y".repeat(200)}`);

    const reopened = await SessionStore.open(store.file);
    expect(reopened.messages().map(messageText)).toEqual(texts);
  });

  it("passes custom instructions and the previous summary to the model", async () => {
    const store = await longSession();
    const requests: ProviderRequest[] = [];
    const provider = capturingProvider(requests, ["first summary", "second summary"]);

    await compactSession(store, provider, {
      settings: tinyBudget,
      instructions: "focus on file names",
    });
    expect(messageText(requests[0]?.messages[0] as Message)).toContain("focus on file names");

    for (let turn = 5; turn <= 8; turn++) {
      await store.append(textMessage("user", `question ${turn} ${"x".repeat(200)}`));
      await store.append(textMessage("assistant", `answer ${turn} ${"y".repeat(200)}`));
    }
    const second = await compactSession(store, provider, { settings: tinyBudget });

    expect(messageText(requests[1]?.messages[0] as Message)).toContain("first summary");
    expect(second?.summary).toBe("second summary");
  });

  it("accumulates file tracking across repeated compactions", async () => {
    const store = await longSession();
    const provider = new MockProvider([textTurn("one"), textTurn("two")]);

    const first = await compactSession(store, provider, { settings: tinyBudget });
    for (let turn = 5; turn <= 8; turn++) {
      await store.append(textMessage("user", `question ${turn} ${"x".repeat(200)}`));
      await store.append(textMessage("assistant", `answer ${turn} ${"y".repeat(200)}`));
    }
    const second = await compactSession(store, provider, { settings: tinyBudget });

    expect(second?.details?.readFiles).toEqual(
      expect.arrayContaining(first?.details?.readFiles ?? []),
    );
  });

  it("compacts one branch without disturbing another", async () => {
    const store = await longSession();
    const fourthAnswer = store.entries().at(-1) as { id: string };
    store.branch(fourthAnswer.id);
    const otherTip = await store.append(textMessage("user", "other branch"));

    store.branch(fourthAnswer.id);
    await store.append(textMessage("user", `question 5 ${"x".repeat(200)}`));
    await store.append(textMessage("assistant", `answer 5 ${"y".repeat(200)}`));
    await compactSession(store, new MockProvider([textTurn("summary")]), {
      settings: tinyBudget,
    });

    store.branch(otherTip.id);
    const otherTexts = store.messages().map(messageText);
    expect(otherTexts).not.toContain("summary");
    expect(otherTexts.at(-1)).toBe("other branch");
    expect(otherTexts).toContain(`question 1 ${"x".repeat(200)}`);
  });
});

describe("serializeConversation", () => {
  it("renders roles, tool calls, and truncated tool results", () => {
    const text = serializeConversation([
      textMessage("user", "do it"),
      {
        role: "assistant",
        parts: [{ type: "tool-call", callId: "c", name: "read", arguments: { path: "a.ts" } }],
      },
      {
        role: "tool",
        parts: [{ type: "tool-result", callId: "c", output: "z".repeat(2500), isError: false }],
      },
    ]);

    expect(text).toContain("[User]: do it");
    expect(text).toContain('[Assistant tool calls]: read({"path":"a.ts"})');
    expect(text).toContain("characters truncated");
    expect(text).not.toContain("z".repeat(2100));
  });
});

function capturingProvider(sink: ProviderRequest[], replies: string[]): Provider {
  return {
    name: "capturing",
    stream(request): AsyncIterable<TurnDelta> {
      sink.push(request);
      const reply = replies[sink.length - 1] ?? "";
      return (async function* () {
        yield { type: "text", text: reply } as TurnDelta;
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } } as TurnDelta;
      })();
    },
  };
}
