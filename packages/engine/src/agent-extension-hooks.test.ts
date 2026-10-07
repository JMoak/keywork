import { describe, expect, it } from "vitest";
import { Agent } from "./agent.ts";
import { type EngineEvents, EventBus } from "./bus.ts";
import type { ExtensionDefinition, ExtensionFactory } from "./extensions/hooks.ts";
import { ExtensionHost } from "./extensions/host.ts";
import { messageText, type ToolCallPart } from "./messages.ts";
import { textTurn, toolCallTurn } from "./mock-provider.ts";
import { recordingProvider } from "./testing/index.ts";
import type { Tool } from "./tools.ts";

const echoTool: Tool = {
  name: "echo",
  description: "Repeats its input back.",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  execute: async (args) => `echo: ${(args as { text: string }).text}`,
};

const bashTool: Tool = {
  name: "bash",
  description: "Runs a command.",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  execute: async () => "ran",
};

function inline(name: string, activate: ExtensionFactory): ExtensionDefinition {
  return { name, source: "inline", activate };
}

function call(callId: string, name: string, args: unknown): ToolCallPart {
  return { type: "tool-call", callId, name, arguments: args };
}

async function hostedAgent(
  script: Parameters<typeof recordingProvider>[0],
  ...definitions: ExtensionDefinition[]
) {
  const bus = new EventBus<EngineEvents>();
  const notices: EngineEvents["extension.notice"][] = [];
  bus.on("extension.notice", (notice) => notices.push(notice));
  const host = new ExtensionHost({ bus, reservedToolNames: ["echo", "bash"] });
  for (const definition of definitions) await host.activate(definition);
  const provider = recordingProvider(script);
  const agent = new Agent({
    provider,
    bus,
    tools: [echoTool, bashTool],
    hooks: host.agentHooks(),
    systemPrompt: "You are keywork.",
  });
  return { agent, host, provider, notices };
}

describe("Agent with an extension host", () => {
  it("puts a registered tool on the model's tool list and runs it when called", async () => {
    const { agent, provider } = await hostedAgent(
      [toolCallTurn(call("c1", "greet", { name: "Ada" })), textTurn("greeted")],
      inline("greeter", (api) => {
        api.registerTool({
          name: "greet",
          description: "Greets someone.",
          parameters: { type: "object", properties: { name: { type: "string" } } },
          execute: async (args) => `hello, ${(args as { name: string }).name}`,
        });
      }),
    );

    const final = await agent.send("greet Ada");

    expect(messageText(final)).toBe("greeted");
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "bash", "greet"]);
    const toolMessage = agent.history().find((message) => message.role === "tool");
    expect(toolMessage?.parts[0]).toMatchObject({ output: "hello, Ada", isError: false });
  });

  it("lets a tool_call gate deny before the trust gate and modify arguments in flight", async () => {
    const finished: EngineEvents["tool.finished"][] = [];
    const started: string[] = [];
    const { agent } = await hostedAgent(
      [
        toolCallTurn(call("c1", "bash", { command: "rm -rf /" })),
        toolCallTurn(call("c2", "echo", { text: "quiet" })),
        textTurn("done"),
      ],
      inline("gatekeeper", (api) => {
        api.on("tool_call", ({ call: requested }) => {
          if (requested.name === "bash")
            return { action: "deny", reason: "shell is off limits here" };
          const { text } = requested.arguments as { text: string };
          return { action: "modify", arguments: { text: text.toUpperCase() } };
        });
      }),
    );
    agent.bus.on("tool.finished", (outcome) => finished.push(outcome));
    agent.bus.on("tool.started", ({ call: ran }) => started.push(JSON.stringify(ran.arguments)));

    await agent.send("do things");

    expect(finished).toEqual([
      {
        callId: "c1",
        output: "refused by extension gatekeeper: shell is off limits here",
        isError: true,
      },
      { callId: "c2", output: "echo: QUIET", isError: false },
    ]);
    expect(started).toEqual(['{"command":"rm -rf /"}', '{"text":"QUIET"}']);
  });

  it("appends context fragments to the system prompt on every provider request", async () => {
    let fragments = 0;
    const { agent, provider } = await hostedAgent(
      [toolCallTurn(call("c1", "echo", { text: "x" })), textTurn("ok")],
      inline("advisor", (api) => {
        api.on("context", () => {
          fragments += 1;
          return `Advice ${fragments}.`;
        });
      }),
    );

    await agent.send("go");

    expect(provider.requests.map((request) => request.systemPrompt)).toEqual([
      "You are keywork.\n\nAdvice 1.",
      "You are keywork.\n\nAdvice 2.",
    ]);
  });

  it("observes the whole turn through the wired hooks, in order", async () => {
    const seen: string[] = [];
    const { agent, host } = await hostedAgent(
      [toolCallTurn(call("c1", "echo", { text: "hi" })), textTurn("bye")],
      inline("watcher", (api) => {
        api.on("turn_start", ({ userText }) => void seen.push(`turn_start:${userText}`));
        api.on("message_appended", ({ message }) => void seen.push(`message:${message.role}`));
        api.on(
          "tool_result",
          ({ call: ran, output }) => void seen.push(`tool_result:${ran?.name}:${output}`),
        );
        api.on(
          "turn_end",
          ({ message, interrupted }) =>
            void seen.push(`turn_end:${messageText(message)}:${interrupted}`),
        );
      }),
    );

    await agent.send("hello");
    await host.settle();

    expect(seen).toEqual([
      "message:user",
      "turn_start:hello",
      "message:assistant",
      "tool_result:echo:echo: hi",
      "message:tool",
      "message:assistant",
      "turn_end:bye:false",
    ]);
  });

  it("finishes the turn when an extension breaks mid-flight and withdraws its tool", async () => {
    const { agent, host, provider, notices } = await hostedAgent(
      [toolCallTurn(call("c1", "echo", { text: "a" })), textTurn("still here")],
      inline("fragile", (api) => {
        api.registerTool({
          name: "doomed",
          description: "Withdrawn once its owner misbehaves.",
          parameters: { type: "object" },
          execute: async () => "unreachable",
        });
        api.on("turn_start", () => {
          throw new Error("cannot handle turns");
        });
      }),
      inline("sturdy", (api) => {
        api.on("context", () => "Stay calm.");
      }),
    );

    expect(host.tools().map((tool) => tool.name)).toEqual(["doomed"]);

    const final = await agent.send("hello");
    await host.settle();

    expect(messageText(final)).toBe("still here");
    expect(provider.requests.map((request) => request.tools.map((tool) => tool.name))).toEqual([
      ["echo", "bash"],
      ["echo", "bash"],
    ]);
    expect(provider.requests[1]?.systemPrompt).toBe("You are keywork.\n\nStay calm.");
    expect(notices.map((notice) => notice.message)).toEqual([
      'extension "fragile" quarantined during turn_start: cannot handle turns',
    ]);
  });

  it("runs unchanged without hooks", async () => {
    const provider = recordingProvider([textTurn("plain")]);
    const agent = new Agent({ provider, tools: [echoTool], systemPrompt: "Base." });
    expect(messageText(await agent.send("hi"))).toBe("plain");
    expect(provider.requests[0]?.systemPrompt).toBe("Base.");
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });
});
