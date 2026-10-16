import { describe, expect, it } from "vitest";
import { MockProvider, textTurn } from "../../packages/engine/src/index.ts";
import { chatJudge, parseRelation, parseRelevance } from "./judge.ts";

describe("parseRelevance", () => {
  it("reads the verdict word and a one-line reason", () => {
    expect(parseRelevance("RELEVANT: the agent cited the gate")).toEqual({
      relevant: true,
      reason: "the agent cited the gate",
    });
    expect(parseRelevance("Thinking...\nirrelevant - nothing about tokens")).toEqual({
      relevant: false,
      reason: "- nothing about tokens",
    });
  });

  it("refuses a reply with no verdict", () => {
    expect(parseRelevance("I am not sure")).toBeUndefined();
  });
});

describe("parseRelation", () => {
  it("reads one of the catalog's relations", () => {
    expect(parseRelation("newer-supersedes-older: the workflow tags now")).toEqual({
      relation: "newer-supersedes-older",
      reason: "the workflow tags now",
    });
    expect(parseRelation("similar: kind of")).toBeUndefined();
  });
});

describe("chatJudge", () => {
  it("asks the person's chat model and parses what it says", async () => {
    const judge = chatJudge(
      new MockProvider([textTurn("RELEVANT: used it"), textTurn("duplicate: same rule")]),
      "mock/judge",
    );
    expect(judge.id).toBe("mock/judge");
    expect(
      await judge.relevance({
        action: { callId: "c", tool: "bash", subject: "bun run test", subjectKind: "command" },
        note: { title: "Test Gate", excerpt: "The gate is vitest." },
        turns: ["The gate passes, as [[Test Gate]] requires."],
      }),
    ).toEqual({ relevant: true, reason: "used it" });
    const note = { name: "A", title: "A", provenance: "agent" as const, body: "same" };
    expect(
      await judge.relation({ older: note, newer: { ...note, name: "B", title: "B" } }),
    ).toEqual({
      relation: "duplicate",
      reason: "same rule",
    });
  });
});
