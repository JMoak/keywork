import { type EngineEvents, EventBus } from "./bus.ts";
import { type Message, type ToolCallPart, textMessage, toolCalls, type Usage } from "./messages.ts";
import { type CostRollup, emptyCostRollup, withTurnCost } from "./pricing.ts";
import type { Provider, TurnDelta } from "./provider.ts";
import type { PermissionDecision } from "./session/journal.ts";
import { findTool, type Tool } from "./tools.ts";

export interface ToolGuard {
  confirm?(call: ToolCallPart): Promise<boolean>;
  beforeMutation?(): Promise<void>;
}

export type ToolPermission = "allow" | "ask" | "deny";
export type PermissionResolver = (call: ToolCallPart) => ToolPermission | undefined;

export interface AgentOptions {
  provider: Provider;
  systemPrompt?: string;
  tools?: readonly Tool[];
  bus?: EventBus<EngineEvents>;
  history?: readonly Message[];
  guard?: ToolGuard;
  permissions?: PermissionResolver;
}

export class AgentBusyError extends Error {
  constructor() {
    super("a turn is already in flight; interrupt it or await it first");
    this.name = "AgentBusyError";
  }
}

interface AssistantTurn {
  message: Message;
  usage: Usage;
  interrupted: boolean;
  failure?: Error;
}

export class Agent {
  readonly bus: EventBus<EngineEvents>;
  readonly provider: Provider;
  private readonly systemPrompt: string;
  private readonly tools: readonly Tool[];
  private readonly messages: Message[];
  private readonly guard: ToolGuard | undefined;
  private readonly permissions: PermissionResolver | undefined;
  private totals: Usage = { inputTokens: 0, outputTokens: 0 };
  private costTotals: CostRollup = emptyCostRollup();
  private active: AbortController | undefined;
  private checkpointed = false;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.systemPrompt = options.systemPrompt ?? "";
    this.tools = options.tools ?? [];
    this.bus = options.bus ?? new EventBus();
    this.messages = [...(options.history ?? [])];
    this.guard = options.guard;
    this.permissions = options.permissions;
  }

  history(): readonly Message[] {
    return this.messages;
  }

  usage(): Usage {
    return { ...this.totals };
  }

  cost(): CostRollup {
    return { ...this.costTotals };
  }

  modelId(): string | undefined {
    return this.provider.modelId;
  }

  busy(): boolean {
    return this.active !== undefined;
  }

  interrupt(): void {
    this.active?.abort();
  }

  async send(userText: string, signal?: AbortSignal): Promise<Message> {
    if (this.active !== undefined) throw new AgentBusyError();
    const controller = new AbortController();
    this.active = controller;
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });

    this.checkpointed = false;
    this.messages.push(textMessage("user", userText));
    this.bus.emit("turn.started", { userText });
    try {
      return await this.runUntilFinalMessage(controller);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.bus.emit("engine.error", { error });
      throw error;
    } finally {
      this.release(controller);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async runUntilFinalMessage(controller: AbortController): Promise<Message> {
    const signal = controller.signal;
    while (true) {
      const turn = await this.streamAssistantTurn(signal);
      this.totals = addUsage(this.totals, turn.usage);
      this.costTotals = withTurnCost(this.costTotals, turn.usage, this.provider.modelId);
      if (turn.failure !== undefined) throw turn.failure;
      if (turn.interrupted) {
        if (turn.message.parts.length > 0) this.messages.push(turn.message);
        return this.finishInterrupted(controller, turn.message);
      }
      this.messages.push(turn.message);

      const calls = toolCalls(turn.message);
      if (calls.length === 0) return this.finishCompleted(controller, turn);
      await this.executeToolCalls(calls, signal);
      if (signal.aborted) return this.finishInterrupted(controller, turn.message);
    }
  }

  private finishCompleted(controller: AbortController, turn: AssistantTurn): Message {
    this.release(controller);
    this.bus.emit("turn.completed", { message: turn.message, usage: turn.usage });
    return turn.message;
  }

  private finishInterrupted(controller: AbortController, message: Message): Message {
    this.settleOrphanedToolCalls(message);
    this.release(controller);
    this.bus.emit("turn.interrupted", { message });
    return message;
  }

  private settleOrphanedToolCalls(message: Message): void {
    const settled = this.settledCallIds();
    for (const call of toolCalls(message)) {
      if (settled.has(call.callId)) continue;
      this.messages.push({
        role: "tool",
        parts: [
          {
            type: "tool-result",
            callId: call.callId,
            output: "interrupted before execution",
            isError: true,
          },
        ],
      });
    }
  }

  private settledCallIds(): Set<string> {
    const ids = new Set<string>();
    for (const message of this.messages) {
      for (const part of message.parts) {
        if (part.type === "tool-result") ids.add(part.callId);
      }
    }
    return ids;
  }

  private release(controller: AbortController): void {
    if (this.active === controller) this.active = undefined;
  }

  private async streamAssistantTurn(signal: AbortSignal): Promise<AssistantTurn> {
    const message: Message = { role: "assistant", parts: [] };
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const request = {
      systemPrompt: this.systemPrompt,
      messages: [...this.messages],
      tools: this.tools,
      signal,
    };
    try {
      for await (const delta of this.provider.stream(request)) {
        this.bus.emit("turn.delta", { delta });
        usage = applyDelta(message, delta, usage);
      }
    } catch (cause) {
      if (signal.aborted) return { message, usage, interrupted: true };
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      return { message, usage, interrupted: false, failure };
    }
    return { message, usage, interrupted: false };
  }

  private async executeToolCalls(calls: ToolCallPart[], signal: AbortSignal): Promise<void> {
    for (const call of calls) {
      if (signal.aborted) return;
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
    signal: AbortSignal,
  ): Promise<{ callId: string; output: string; isError: boolean }> {
    try {
      const tool = findTool(this.tools, call.name);
      const policyVerdict = this.permissions?.(call);
      const verdict = policyVerdict ?? defaultPermission(tool);
      const gate = policyVerdict === undefined ? "default" : "policy";
      if (verdict === "deny") {
        this.emitPermissionDecision(call, "denied", gate);
        return { callId: call.callId, output: "denied by permission policy", isError: true };
      }
      if (verdict === "ask") {
        const askedUser = this.guard?.confirm !== undefined;
        const approved = await this.confirmWithGuard(call);
        this.emitPermissionDecision(
          call,
          approved ? "granted" : "denied",
          askedUser ? "user" : gate,
        );
        if (!approved) {
          return { callId: call.callId, output: "declined by user", isError: true };
        }
      } else {
        this.emitPermissionDecision(call, "granted", gate);
      }
      if (tool.mutates === true) await this.checkpointOnce();
      const output = await tool.execute(call.arguments, signal);
      return { callId: call.callId, output, isError: false };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return { callId: call.callId, output: reason, isError: true };
    }
  }

  private emitPermissionDecision(
    call: ToolCallPart,
    verdict: PermissionDecision["verdict"],
    gate: PermissionDecision["gate"],
  ): void {
    this.bus.emit("gate.permission", {
      decision: { tool: call.name, callId: call.callId, verdict, gate },
    });
  }

  private confirmWithGuard(call: ToolCallPart): Promise<boolean> {
    return this.guard?.confirm?.(call) ?? Promise.resolve(true);
  }

  private async checkpointOnce(): Promise<void> {
    if (this.checkpointed) return;
    this.checkpointed = true;
    await this.guard?.beforeMutation?.();
  }
}

function defaultPermission(tool: Tool): ToolPermission {
  return tool.mutates === true ? "ask" : "allow";
}

function addUsage(left: Usage, right: Usage): Usage {
  const cacheCreation =
    (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0);
  const cacheRead = (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0);
  const metered = left.costUsd !== undefined || right.costUsd !== undefined;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheCreation > 0 && { cacheCreationInputTokens: cacheCreation }),
    ...(cacheRead > 0 && { cacheReadInputTokens: cacheRead }),
    ...(metered && { costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) }),
  };
}

function applyDelta(message: Message, delta: TurnDelta, usage: Usage): Usage {
  switch (delta.type) {
    case "text":
      appendText(message, delta.text);
      return usage;
    case "tool-call":
      message.parts.push(delta.call);
      return usage;
    case "redacted-thinking":
      message.parts.push(delta.part);
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
