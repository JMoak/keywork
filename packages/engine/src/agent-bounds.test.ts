import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent.ts";
import type { EngineEvents } from "./bus.ts";
import type { Message } from "./messages.ts";
import { MockProvider, textTurn, toolCallTurn } from "./mock-provider.ts";
import type { Provider, ProviderRequest, TurnDelta } from "./provider.ts";
import { defaultToolOutputBudget, SpillStore } from "./session/spill.ts";
import type { Tool } from "./tools.ts";

const tempDir = scratchDirs("keywork-agent-bounds-");

const firehoseLines = 300_000;
const firehoseBytes = firehoseLines * "0123456789\n".length;

const firehose: Tool = {
  name: "firehose",
  description: "Emits several megabytes.",
  parameters: { type: "object" },
  execute: async () => "0123456789\n".repeat(firehoseLines),
};

function requestCapturing(script: MockProvider): { provider: Provider; requests: Message[][] } {
  const requests: Message[][] = [];
  return {
    requests,
    provider: {
      name: "capturing",
      modelId: undefined,
      capabilities: undefined,
      stream: (request: ProviderRequest): AsyncIterable<TurnDelta> => {
        requests.push(structuredClone([...request.messages]));
        return script.stream(request);
      },
    },
  };
}

function firehoseRun(spills: SpillStore) {
  const script = new MockProvider([
    toolCallTurn({ type: "tool-call", callId: "c1", name: "firehose", arguments: {} }),
    textTurn("read it"),
  ]);
  const { provider, requests } = requestCapturing(script);
  const agent = new Agent({ provider, tools: [firehose], spills });
  return { agent, requests };
}

describe("Agent bounded tool output", () => {
  it("keeps a firehose result under budget in memory, writes one spill, and sends the bounded form", async () => {
    const spills = SpillStore.beside(join(await tempDir(), "s.jsonl"));
    const { agent, requests } = firehoseRun(spills);
    const finished: EngineEvents["tool.finished"][] = [];
    agent.bus.on("tool.finished", (event) => finished.push(event));

    await agent.send("go");

    const toolMessage = agent.history()[2];
    const part = toolMessage?.parts[0];
    expect(part?.type).toBe("tool-result");
    if (part?.type !== "tool-result") return;
    expect(Buffer.byteLength(part.output)).toBeLessThanOrEqual(defaultToolOutputBudget);
    expect(part.spill?.bytes).toBe(firehoseBytes);
    expect(await readdir(spills.dir)).toEqual([`${part.spill?.id}.txt`]);
    expect(finished[0]).toEqual({
      callId: "c1",
      output: part.output,
      isError: false,
      spill: part.spill,
    });

    const carried = requests[1]?.[2]?.parts[0];
    expect(carried?.type === "tool-result" && carried.output).toBe(part.output);
    const requestBytes = Buffer.byteLength(JSON.stringify(requests[1]));
    expect(requestBytes).toBeLessThan(defaultToolOutputBudget * 1.25);
    expect(requestBytes).toBeLessThan(firehoseBytes / 40);
  });

  it("leaves results whole when no spill store is wired", async () => {
    const script = new MockProvider([
      toolCallTurn({ type: "tool-call", callId: "c1", name: "firehose", arguments: {} }),
      textTurn("read it"),
    ]);
    const agent = new Agent({ provider: script, tools: [firehose] });

    await agent.send("go");

    const part = agent.history()[2]?.parts[0];
    expect(part?.type === "tool-result" && part.output.length).toBe(firehoseBytes);
    expect(part?.type === "tool-result" && part.spill).toBeUndefined();
  });

  it("stamps live tool output with the running call", async () => {
    const seen: EngineEvents["tool.output"][] = [];
    let agent: Agent | undefined;
    const talkative: Tool = {
      name: "talkative",
      description: "Streams while it runs.",
      parameters: { type: "object" },
      execute: async () => {
        agent?.reportToolOutput("one ");
        agent?.reportToolOutput("two");
        return "done";
      },
    };
    agent = new Agent({
      provider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "c9", name: "talkative", arguments: {} }),
        textTurn("ok"),
      ]),
      tools: [talkative],
    });
    agent.bus.on("tool.output", (event) => seen.push(event));

    await agent.send("go");

    expect(seen).toEqual([
      { chunk: "one ", callId: "c9" },
      { chunk: "two", callId: "c9" },
    ]);
    expect(agent.runningCall()).toBeUndefined();
    agent.reportToolOutput("late");
    expect(seen.at(-1)).toEqual({ chunk: "late" });
  });
});
