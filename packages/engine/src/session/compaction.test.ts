import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Message, messageText, textMessage } from "../messages.ts";
import { MockProvider, textTurn } from "../mock-provider.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { compactSession, planCompaction, serializeConversation } from "./compaction.ts";
import { contextBudgetFor } from "./context-budget.ts";
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

const tinyBudget = contextBudgetFor(600);

describe("planCompaction", () => {
  it("keeps as much recent tail as the budget allows", async () => {
    const store = await longSession();
    const tiny = planCompaction(store, tinyBudget);
    const roomy = planCompaction(store, contextBudgetFor(200_000));
    expect(tinyBudget.keepRecent).toBe(60);
    expect(roomy?.entriesToSummarize.length).toBeLessThan(tiny?.entriesToSummarize.length ?? 0);
  });

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

    const entry = await compactSession(store, provider, { budget: tinyBudget });

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
      budget: tinyBudget,
      instructions: "focus on file names",
    });
    expect(messageText(requests[0]?.messages[0] as Message)).toContain("focus on file names");

    for (let turn = 5; turn <= 8; turn++) {
      await store.append(textMessage("user", `question ${turn} ${"x".repeat(200)}`));
      await store.append(textMessage("assistant", `answer ${turn} ${"y".repeat(200)}`));
    }
    const second = await compactSession(store, provider, { budget: tinyBudget });

    expect(messageText(requests[1]?.messages[0] as Message)).toContain("first summary");
    expect(second?.summary).toBe("second summary");
  });

  it("accumulates file tracking across repeated compactions", async () => {
    const store = await longSession();
    const provider = new MockProvider([textTurn("one"), textTurn("two")]);

    const first = await compactSession(store, provider, { budget: tinyBudget });
    for (let turn = 5; turn <= 8; turn++) {
      await store.append(textMessage("user", `question ${turn} ${"x".repeat(200)}`));
      await store.append(textMessage("assistant", `answer ${turn} ${"y".repeat(200)}`));
    }
    const second = await compactSession(store, provider, { budget: tinyBudget });

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
      budget: tinyBudget,
    });

    store.branch(otherTip.id);
    const otherTexts = store.messages().map(messageText);
    expect(otherTexts).not.toContain("summary");
    expect(otherTexts.at(-1)).toBe("other branch");
    expect(otherTexts).toContain(`question 1 ${"x".repeat(200)}`);
  });
});

describe("pinned skill content", () => {
  const skillBody =
    'Skill "deploy" (files in /s/deploy):\n\n1. Run `make ship`.\n2. Check </skill_content> twice.';

  async function sessionWithSkill(): Promise<SessionStore> {
    const store = await SessionStore.create(await sessionFile(), ".");
    await store.append(textMessage("user", `deploy please ${"x".repeat(200)}`));
    await appendToolTurn(store, "s1", "skill", { name: "deploy" }, skillBody);
    await appendToolTurn(
      store,
      "v1",
      "skill_view",
      { name: "deploy", file: "ref.md" },
      "a reference",
    );
    await appendToolTurn(store, "r1", "read", { path: "old.ts" }, "old tool output");
    for (let turn = 1; turn <= 3; turn++) {
      await store.append(textMessage("user", `question ${turn} ${"x".repeat(200)}`));
      await store.append(textMessage("assistant", `answer ${turn} ${"y".repeat(200)}`));
    }
    return store;
  }

  it("keeps a loaded skill verbatim while cutting older tool results", async () => {
    const store = await sessionWithSkill();

    const entry = await compactSession(store, new MockProvider([textTurn("## Goal\nship")]), {
      budget: tinyBudget,
    });

    const context = store.messages().map(messageText).join("\n");
    expect(entry?.summary.startsWith("## Goal\nship\n\n")).toBe(true);
    expect(context).toContain(`<skill_content name="deploy">\n${skillBody}\n</skill_content>`);
    expect(context).not.toContain("old tool output");
    expect(context).not.toContain("a reference");
    const kept = store.entry(entry?.firstKeptEntryId ?? "");
    expect(kept?.type === "message" && kept.message.role).not.toBe("tool");
  });

  it("carries pinned skills through later compactions and takes the latest load", async () => {
    const store = await sessionWithSkill();
    const requests: ProviderRequest[] = [];
    const provider = capturingProvider(requests, ["first", "second"]);
    await compactSession(store, provider, { budget: tinyBudget });

    await appendToolTurn(store, "s2", "skill", { name: "lint" }, "Lint body.");
    await appendToolTurn(store, "s3", "skill", { name: "lint" }, "Lint body v2.");
    await appendToolTurn(store, "s4", "skill", { name: "missing" }, "unknown skill", true);
    for (let turn = 4; turn <= 7; turn++) {
      await store.append(textMessage("user", `question ${turn} ${"x".repeat(200)}`));
      await store.append(textMessage("assistant", `answer ${turn} ${"y".repeat(200)}`));
    }
    const second = await compactSession(store, provider, { budget: tinyBudget });

    const secondRequest = messageText(requests[1]?.messages[0] as Message);
    expect(secondRequest).toContain("first");
    expect(secondRequest).not.toContain("kept verbatim");
    expect(second?.summary).toContain(
      `<skill_content name="deploy">\n${skillBody}\n</skill_content>\n\n<skill_content name="lint">\nLint body v2.\n</skill_content>`,
    );
    expect(second?.summary).not.toContain("Lint body.\n");
    expect(second?.summary).not.toContain('name="missing"');
  });
});

async function appendToolTurn(
  store: SessionStore,
  callId: string,
  name: string,
  args: Record<string, string>,
  output: string,
  isError = false,
): Promise<void> {
  await store.append({
    role: "assistant",
    parts: [{ type: "tool-call", callId, name, arguments: args }],
  });
  await store.append({
    role: "tool",
    parts: [{ type: "tool-result", callId, output, isError }],
  });
}

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

describe("thinking across a compaction", () => {
  const owner = { provider: "anthropic", model: "claude-opus-5-5" };
  const thinking = (signature: string): Message["parts"][number] => ({
    type: "redacted-thinking",
    data: JSON.stringify({ type: "thinking", thinking: "", signature }),
    owner,
  });
  const signaturesIn = (messages: readonly Message[]) =>
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "redacted-thinking" ? [JSON.parse(part.data).signature as string] : [],
      ),
    );

  it("strips thinking bound to the old prefix from the kept tail and keeps blocks made after", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    for (let turn = 1; turn <= 4; turn++) {
      await store.append(textMessage("user", `question ${turn} ${"x".repeat(200)}`));
      await store.append({
        role: "assistant",
        parts: [thinking(`before-${turn}`), { type: "text", text: `answer ${turn}` }],
      });
    }
    expect(signaturesIn(store.messages())).toHaveLength(4);

    await compactSession(store, new MockProvider([textTurn("## Goal\nfolded")]), {
      budget: tinyBudget,
    });
    expect(signaturesIn(store.messages())).toEqual([]);
    expect(store.messages().map(messageText)).toContain("answer 4");

    await store.append(textMessage("user", "after the fold"));
    await store.append({
      role: "assistant",
      parts: [thinking("after-1"), { type: "text", text: "fresh" }],
    });
    expect(signaturesIn(store.messages())).toEqual(["after-1"]);
    expect(signaturesIn((await SessionStore.open(store.file)).messages())).toEqual(["after-1"]);
  });
});
