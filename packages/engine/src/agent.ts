import { type EngineEvents, EventBus } from "./bus.ts";
import { type Message, type ToolCallPart, textMessage, toolCalls, type Usage } from "./messages.ts";
import type { Provider, TurnDelta } from "./provider.ts";
import { findTool, type Tool } from "./tools.ts";

export interface AgentOptions {
  provider: Provider;
  systemPrompt?: string;
  tools?: readonly Tool[];
  bus?: EventBus<EngineEvents>;
}

export class Agent {
  readonly bus: EventBus<EngineEvents>;
  private readonly provider: Provider;
  private readonly systemPrompt: string;
  private readonly tools: readonly Tool[];
  private readonly messages: Message[] = [];

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.systemPrompt = options.systemPrompt ?? "";
    this.tools = options.tools ?? [];
    this.bus = options.bus ?? new EventBus();
  }

  history(): readonly Message[] {
    return this.messages;
  }

  async send(userText: string, signal?: AbortSignal): Promise<Message> {
    this.messages.push(textMessage("user", userText));
    this.bus.emit("turn.started", { userText });
    try {
      return await this.runUntilFinalMessage(signal);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.bus.emit("engine.error", { error });
      throw error;
    }
  }

  private async runUntilFinalMessage(signal?: AbortSignal): Promise<Message> {
    while (true) {
      const { message, usage } = await this.streamAssistantTurn(signal);
      this.messages.push(message);
      const calls = toolCalls(message);
      if (calls.length === 0) {
        this.bus.emit("turn.completed", { message, usage });
        return message;
      }
      await this.executeToolCalls(calls, signal);
    }
  }

  private async streamAssistantTurn(
    signal?: AbortSignal,
  ): Promise<{ message: Message; usage: Usage }> {
    const message: Message = { role: "assistant", parts: [] };
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const request = {
      systemPrompt: this.systemPrompt,
      messages: [...this.messages],
      tools: this.tools,
      ...(signal !== undefined && { signal }),
    };
    for await (const delta of this.provider.stream(request)) {
      this.bus.emit("turn.delta", { delta });
      usage = applyDelta(message, delta, usage);
    }
    return { message, usage };
  }

  private async executeToolCalls(calls: ToolCallPart[], signal?: AbortSignal): Promise<void> {
    for (const call of calls) {
      this.bus.emit("tool.started", { call });
      const result = await this.executeToolCall(call, signal);
      this.bus.emit("tool.finished", result);
      this.messages.push({
        role: "tool",
        parts: [{ type: "tool-result", ...result }],
      });
    }
  }

  private async executeToolCall(
    call: ToolCallPart,
    signal?: AbortSignal,
  ): Promise<{ callId: string; output: string; isError: boolean }> {
    try {
      const tool = findTool(this.tools, call.name);
      const output = await tool.execute(call.arguments, signal);
      return { callId: call.callId, output, isError: false };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return { callId: call.callId, output: reason, isError: true };
    }
  }
}

function applyDelta(message: Message, delta: TurnDelta, usage: Usage): Usage {
  switch (delta.type) {
    case "text":
      appendText(message, delta.text);
      return usage;
    case "tool-call":
      message.parts.push(delta.call);
      return usage;
    case "done":
      return delta.usage;
  }
}

function appendText(message: Message, text: string): void {
  const last = message.parts.at(-1);
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  message.parts.push({ type: "text", text });
}
