import { describe, expect, it } from "vitest";
import { Agent } from "./agent.ts";
import { type Message, messageText, textMessage } from "./messages.ts";
import { textTurn, toolCallTurn } from "./mock-provider.ts";
import type { ProviderRequest } from "./provider.ts";
import type { NoteSource } from "./request-notes.ts";
import { recordingProvider } from "./testing/index.ts";
import type { Tool } from "./tools.ts";

const noop: Tool = {
  name: "noop",
  description: "Does nothing.",
  parameters: { type: "object" },
  execute: async () => "did nothing",
};

function noteOnce(...notes: (string | undefined)[]): NoteSource {
  const pending = [...notes];
  return () => pending.shift();
}

function callNoop(callId: string) {
  return toolCallTurn({ type: "tool-call", callId, name: "noop", arguments: {} });
}

describe("a note the harness has for the model", () => {
  it("lands ahead of the prompt on a turn's first request", async () => {
    const provider = recordingProvider([textTurn("hello")]);
    const agent = new Agent({ provider, notes: noteOnce("[yard] something settled.") });

    await agent.send("what next?");

    expect(provider.requests[0]?.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "[yard] something settled.\n\n" },
      { type: "text", text: "what next?" },
    ]);
  });

  it("lands at the end of the last tool result when it arrives between tool batches", async () => {
    const provider = recordingProvider([callNoop("a"), textTurn("done")]);
    const agent = new Agent({ provider, tools: [noop], notes: noteOnce(undefined, "[yard] now.") });

    await agent.send("go");

    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      parts: [
        { type: "tool-result", callId: "a", output: "did nothing\n\n[yard] now.", isError: false },
      ],
    });
  });

  it("is said once, and later requests keep it where it landed so the prefix never moves", async () => {
    const provider = recordingProvider([callNoop("a"), callNoop("b"), textTurn("done")]);
    const agent = new Agent({ provider, tools: [noop], notes: noteOnce("[yard] now.") });

    await agent.send("go");

    const [first, second, third] = provider.requests as [
      ProviderRequest,
      ProviderRequest,
      ProviderRequest,
    ];
    const everyText = (request: ProviderRequest) =>
      request.messages.map(messageText).join(" ") + toolOutputs(request.messages);
    expect(firstIndexOf(everyText(third), "[yard] now.")).toBe(
      lastIndexOf(everyText(third), "[yard] now."),
    );
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(third.messages.slice(0, second.messages.length)).toEqual(second.messages);
  });

  it("never joins the history or the journal", async () => {
    const appended: Message[] = [];
    const provider = recordingProvider([textTurn("hello")]);
    const agent = new Agent({
      provider,
      notes: noteOnce("[yard] something settled."),
      hooks: { messageAppended: (message) => appended.push(message) },
    });

    await agent.send("what next?");

    expect(agent.history().map(messageText)).toEqual(["what next?", "hello"]);
    expect(appended.map(messageText)).toEqual(["what next?", "hello"]);
  });

  it("never varies the system prompt", async () => {
    const provider = recordingProvider([callNoop("a"), textTurn("done")]);
    const agent = new Agent({
      provider,
      tools: [noop],
      systemPrompt: "You are keywork.",
      notes: noteOnce("[yard] now."),
    });

    await agent.send("go");

    expect(provider.requests.map((request) => request.systemPrompt)).toEqual([
      "You are keywork.",
      "You are keywork.",
    ]);
  });

  it("starts no turn of its own, and is heard only by the next request", async () => {
    const provider = recordingProvider([textTurn("one"), textTurn("two")]);
    let pending: string | undefined;
    const agent = new Agent({
      provider,
      notes: () => {
        const note = pending;
        pending = undefined;
        return note;
      },
    });

    await agent.send("first");
    pending = "[yard] settled while idle.";
    await Promise.resolve();

    expect(provider.requests).toHaveLength(1);
    await agent.send("second");
    expect(provider.requests).toHaveLength(2);
    expect(messageText(provider.requests[1]?.messages.at(-1) as Message)).toBe(
      "[yard] settled while idle.\n\nsecond",
    );
  });

  it("waits for a message that can carry it when a settled batch leaves none", async () => {
    let asked = 0;
    const provider = recordingProvider([callNoop("a"), textTurn("done")]);
    const agent = new Agent({
      provider,
      tools: [noop],
      notes: () => {
        asked += 1;
        return "[yard] when it can land.";
      },
    });
    agent.settleToolBatchesWith(async (history) => [
      ...history.slice(0, -1),
      textMessage("assistant", "compacted"),
    ]);

    await agent.send("go");

    expect(asked).toBe(1);
    expect(provider.requests[1]?.messages.map(messageText)).not.toContain(
      "[yard] when it can land.",
    );
  });

  it("is dropped with the history a settlement replaces", async () => {
    const provider = recordingProvider([callNoop("a"), textTurn("done")]);
    const agent = new Agent({ provider, tools: [noop], notes: noteOnce("[yard] now.") });
    agent.settleToolBatchesWith(async (history) => [...history]);

    await agent.send("go");

    expect(provider.requests[0]?.messages.map(messageText)).toEqual(["[yard] now.\n\ngo"]);
    expect(provider.requests[1]?.messages.map(messageText)).toEqual(["go", "", ""]);
  });

  it("leaves the request exactly as the history when there is none", async () => {
    const provider = recordingProvider([textTurn("hello")]);
    const agent = new Agent({ provider, notes: () => undefined });

    await agent.send("hi");

    expect(provider.requests[0]?.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "hi" }] },
    ]);
  });
});

function toolOutputs(messages: readonly Message[]): string {
  return messages
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "tool-result" ? [part.output] : [])),
    )
    .join(" ");
}

function firstIndexOf(text: string, needle: string): number {
  return text.indexOf(needle);
}

function lastIndexOf(text: string, needle: string): number {
  return text.lastIndexOf(needle);
}
