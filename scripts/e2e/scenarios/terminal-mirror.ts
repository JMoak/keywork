import { strict as assert } from "node:assert";
import { Agent, MockProvider, type Tool, textTurn } from "../../../packages/engine/src/index.ts";
import type { Scenario } from "../scenario.ts";

const command = "bun test";
const streamedOutput = ["3 files scanned", "12 tests passed", "no failures"];

export const terminalMirror: Scenario = {
  name: "terminal-mirror",
  description: "leader T opens the terminal pane; a mock agent's bash command mirrors into it live",
  goldens: ["mirrored"],
  agentFactory: (guard, history, seams) => {
    let agent: Agent | undefined;
    const bash: Tool = {
      name: "bash",
      description: "Run a shell command.",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      execute: async () => {
        for (const line of streamedOutput) agent?.reportToolOutput(`${line}\n`);
        return `${streamedOutput.join("\n")}\n`;
      },
    };
    agent = new Agent({
      provider: new MockProvider([
        [
          { type: "text", text: "Running the tests now." },
          {
            type: "tool-call",
            call: { type: "tool-call", callId: "call-1", name: "bash", arguments: { command } },
          },
          { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
        ],
        textTurn("All twelve tests pass."),
      ]),
      tools: [bash],
      guard,
      ...(history !== undefined && { history }),
      ...(seams?.bus !== undefined && { bus: seams.bus }),
    });
    return agent;
  },
  run: async (stage) => {
    await stage.settle();
    await stage.press("ctrl+k", "shift+t");
    const opened = await stage.until("terminal · mirroring");
    assert.ok(opened.includes("agent shell commands appear here"), "the mirror starts empty");
    await stage.capture("opened");

    await stage.press("ctrl+k", "h");
    await stage.type("please run the tests");
    await stage.press("enter");
    const mirrored = await stage.until("All twelve tests pass.");
    assert.ok(mirrored.includes(`$ ${command}`), "the mirror shows the agent's command");
    for (const line of streamedOutput) {
      assert.ok(mirrored.includes(line), `the mirror shows the streamed line: ${line}`);
    }
    assert.ok(mirrored.includes("· done"), "the mirror shows the finished marker");
    await stage.capture("mirrored");

    await stage.quit();
  },
};
