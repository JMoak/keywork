import { type Message, MockProvider, messageText, textMessage, textTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { answerAside, asideRequest, backgroundCharCap } from "./side-question.ts";

const history: Message[] = [
  textMessage("user", "rename the flag"),
  {
    role: "assistant",
    parts: [
      { type: "text", text: "Looking." },
      { type: "tool-call", callId: "c1", name: "grep", arguments: { pattern: "flag" } },
    ],
  },
  {
    role: "tool",
    parts: [{ type: "tool-result", callId: "c1", output: "a.ts:1 flag", isError: false }],
  },
  textMessage("assistant", "Renamed it."),
];

describe("asideRequest", () => {
  it("carries the session as text background, with no tools and no history to extend", () => {
    const request = asideRequest(history, "why that name?");
    expect(request.tools).toEqual([]);
    expect(request.messages).toHaveLength(1);
    const prompt = messageText(request.messages[0] as Message);
    expect(prompt).toContain("user: rename the flag");
    expect(prompt).toContain("[called grep]");
    expect(prompt).toContain("tool result: a.ts:1 flag");
    expect(prompt).toMatch(/<\/session>\n\nwhy that name\?$/);
    expect(request.systemPrompt).toMatch(/background only/);
  });

  it("keeps the newest part of a long session", () => {
    const long = [
      textMessage("user", "old ".repeat(backgroundCharCap)),
      textMessage("user", "newest"),
    ];
    const prompt = messageText(asideRequest(long, "q").messages[0] as Message);
    expect(prompt).toContain("[earlier session cut]");
    expect(prompt).toContain("user: newest");
    expect(prompt.length).toBeLessThan(backgroundCharCap + 200);
  });
});

describe("answerAside", () => {
  it("collects the streamed answer", async () => {
    const provider = new MockProvider([textTurn("  because it was shorter  ")]);
    expect(await answerAside(provider, history, "why?")).toBe("because it was shorter");
  });
});
