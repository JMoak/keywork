import { Agent, MockProvider, type TurnDelta } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationModel } from "./conversation-model.ts";
import { parseChord } from "./keys.ts";
import { describeModelRow, modelPickerOver } from "./model-picker.ts";

function run(model: ConversationModel, line: string): Promise<unknown> {
  for (const character of line) {
    model.handleKey(parseChord(character === " " ? "space" : character), character);
  }
  model.handleKey(parseChord("return"), undefined);
  return model.lastSend;
}

const missedTurn: TurnDelta[] = [
  { type: "text", text: "ok" },
  {
    type: "done",
    usage: { inputTokens: 1_000, outputTokens: 100, cacheCreationInputTokens: 41_850 },
    responseId: "msg_2",
    cacheMiss: { cause: "tools changed", missedTokens: 41_850 },
  },
];

describe("/effort", () => {
  it("sets the agent's effort, records it through the hook, and says when it applies", async () => {
    const agent = new Agent({ provider: new MockProvider([]) });
    const model = new ConversationModel(agent, () => {});
    const recorded: string[] = [];
    model.bindEffortChange(async (level) => {
      recorded.push(level);
    });

    await run(model, "/effort low");
    expect(agent.effort()).toBe("low");
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: "effort low · from your next prompt on",
    });

    await run(model, "/effort");
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: "effort low · /effort low|medium|high|xhigh|max",
    });

    await run(model, "/effort turbo");
    expect(model.entries.at(-1)).toEqual({
      kind: "error",
      text: "unknown effort turbo · /effort low|medium|high|xhigh|max",
    });
    expect(recorded).toEqual(["low"]);
  });

  it("names the provider default before anything is chosen and offers the command", async () => {
    const model = new ConversationModel(new Agent({ provider: new MockProvider([]) }), () => {});
    await run(model, "/effort");
    expect(model.entries.at(-1)).toEqual({
      kind: "info",
      text: "effort at the provider default · /effort low|medium|high|xhigh|max",
    });
    for (const character of "/eff") {
      model.handleKey(parseChord(character), character);
    }
    expect(model.suggestions().map((suggestion) => suggestion.name)).toContain("effort");
  });

  it("carries the level onto a swapped-in agent", () => {
    const first = new Agent({ provider: new MockProvider([]), effort: "max" });
    const model = new ConversationModel(first, () => {});
    const second = new Agent({ provider: new MockProvider([]) });
    model.swapAgent(second);
    expect(second.effort()).toBe("max");
  });

  it("shows the level on the cost line", async () => {
    const agent = new Agent({
      provider: new MockProvider(
        [[{ type: "done", usage: { inputTokens: 1_000, outputTokens: 10 } }]],
        {
          modelId: "claude-opus-5-5",
        },
      ),
      effort: "low",
    });
    const model = new ConversationModel(agent, () => {});
    await agent.send("hi");
    await run(model, "/cost");
    expect(model.entries.at(-1)?.text).toContain(
      "estimated from claude-opus-5-5 rates · effort low",
    );
  });
});

describe("cache-miss reasons", () => {
  it("reads the miss reason in /cost and on the status readout", async () => {
    const agent = new Agent({
      provider: new MockProvider([missedTurn], { modelId: "claude-opus-5-5" }),
    });
    const model = new ConversationModel(agent, () => {});
    await agent.send("hi");

    expect(model.usageSummary()).toMatch(/^\$\S+ · cache missed: tools changed$/);
    await run(model, "/cost");
    expect(model.entries.at(-1)?.text).toContain(
      "cache missed: tools changed · about 42k tokens past the change",
    );
  });

  it("drops the reason once a later turn reports none", async () => {
    const agent = new Agent({
      provider: new MockProvider(
        [missedTurn, [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }]],
        { modelId: "claude-opus-5-5" },
      ),
    });
    const model = new ConversationModel(agent, () => {});
    await agent.send("one");
    await agent.send("two");
    expect(model.usageSummary()).not.toContain("cache missed");
  });
});

describe("progress notes", () => {
  it("render as their own prose entry between tool rows and never absorb later text", async () => {
    const agent = new Agent({
      provider: new MockProvider([
        [
          { type: "progress", text: "Found the stale token. Editing auth.py next." },
          { type: "text", text: "Fixed." },
          { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
      ]),
    });
    const model = new ConversationModel(agent, () => {});
    await run(model, "fix login");

    expect(model.entries.slice(1)).toEqual([
      { kind: "assistant", text: "Found the stale token. Editing auth.py next.", progress: true },
      { kind: "assistant", text: "Fixed." },
    ]);
  });
});

describe("model picker", () => {
  it("shows the effort next to the current model only", () => {
    const choices = [
      {
        reference: "anthropic/claude-opus-5-5",
        provider: "anthropic",
        model: "claude-opus-5-5",
        available: true,
        facts: ["anthropic-messages"],
      },
      {
        reference: "anthropic/claude-sonnet-5-5",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        available: true,
        facts: ["anthropic-messages"],
      },
    ];
    const picker = modelPickerOver(choices, "anthropic/claude-opus-5-5", "high");
    expect(picker.rows().map(describeModelRow)).toEqual([
      "anthropic/claude-opus-5-5 · anthropic-messages · current · effort high",
      "anthropic/claude-sonnet-5-5 · anthropic-messages",
    ]);
  });
});
