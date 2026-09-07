import { type EngineEvents, EventBus, type QueuedPrompt, type SendBehavior } from "./bus.ts";
import { type Message, type ToolCallPart, textMessage, toolCalls, type Usage } from "./messages.ts";
import { type CostRollup, emptyCostRollup, withTurnCost } from "./pricing.ts";
import type { Provider, TurnDelta } from "./provider.ts";
import type { ContextInjection, PermissionDecision, PermissionGate } from "./session/journal.ts";
import type { SpillStore } from "./session/spill.ts";
import { findTool, type Tool } from "./tools.ts";

export type ConfirmingGate = Extract<PermissionGate, "user" | "headless">;

export interface ToolGuard {
  confirm?(call: ToolCallPart): Promise<boolean>;
  gate?: ConfirmingGate;
  beforeMutation?(): Promise<void>;
}

export type ToolPermission = "allow" | "ask" | "deny";
export type PermissionResolver = (call: ToolCallPart) => ToolPermission | undefined;
export type ToolSource = () => readonly Tool[];

export type ActionRecall = (call: ToolCallPart) => Promise<string | undefined>;
export type SpillSource = () => SpillStore | undefined;

export interface DelegatedTurn {
  userText: string;
  signal: AbortSignal;
  bus: EventBus<EngineEvents>;
}

export interface DelegatedOutcome {
  message: Message;
  usage: Usage;
  interrupted: boolean;
  history?: readonly Message[];
}

export type TurnDelegate = (turn: DelegatedTurn) => Promise<DelegatedOutcome>;

export interface AgentOptions {
  provider: Provider;
  turns?: TurnDelegate;
  systemPrompt?: string;
  tools?: readonly Tool[] | ToolSource;
  bus?: EventBus<EngineEvents>;
  history?: readonly Message[];
  guard?: ToolGuard;
  permissions?: PermissionResolver;
  standingInjections?: readonly ContextInjection[];
  actionRecall?: ActionRecall;
  thinking?: boolean;
  spills?: SpillStore | SpillSource;
}

export interface SendOptions {
  behavior?: SendBehavior;
  signal?: AbortSignal;
}

export type TurnSettler = () => Promise<void>;

export class QueuedPromptCancelledError extends Error {
  constructor(id: string) {
    super(`queued prompt ${id} was cancelled before its turn`);
    this.name = "QueuedPromptCancelledError";
  }
}

interface PendingPrompt extends QueuedPrompt {
  signal: AbortSignal | undefined;
  resolve(message: Message): void;
  reject(error: Error): void;
}

interface AssistantTurn {
  message: Message;
  usage: Usage;
  interrupted: boolean;
  failure?: Error;
}

type ToolOutcome = EngineEvents["tool.finished"];

export class Agent {
  readonly bus: EventBus<EngineEvents>;
  readonly provider: Provider;
  private readonly systemPrompt: string;
  private readonly tools: ToolSource;
  private readonly messages: Message[];
  private readonly guard: ToolGuard | undefined;
  private readonly permissions: PermissionResolver | undefined;
  private readonly actionRecall: ActionRecall | undefined;
  private readonly spills: SpillSource;
  private readonly turns: TurnDelegate | undefined;
  private readonly pending: PendingPrompt[] = [];
  private running: ToolCallPart | undefined;
  private unannouncedInjections: readonly ContextInjection[];
  private totals: Usage = { inputTokens: 0, outputTokens: 0 };
  private costTotals: CostRollup = emptyCostRollup();
  private active: AbortController | undefined;
  private holding = false;
  private settler: TurnSettler | undefined;
  private checkpointed = false;
  private thinkingRequested: boolean;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.systemPrompt = options.systemPrompt ?? "";
    this.tools = toolSource(options.tools);
    this.bus = options.bus ?? new EventBus();
    this.messages = [...(options.history ?? [])];
    this.guard = options.guard;
    this.permissions = options.permissions;
    this.actionRecall = options.actionRecall;
    this.spills = spillSource(options.spills);
    this.turns = options.turns;
    this.unannouncedInjections = options.standingInjections ?? [];
    this.thinkingRequested = options.thinking ?? false;
  }

  thinking(): boolean {
    return this.thinkingRequested;
  }

  setThinking(requested: boolean): void {
    this.thinkingRequested = requested;
  }

  history(): readonly Message[] {
    return [...this.messages];
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
    return !this.idle() || this.pending.length > 0;
  }

  queued(): readonly QueuedPrompt[] {
    return this.pending.map(({ id, text, behavior }) => ({ id, text, behavior }));
  }

  interrupt(): void {
    this.active?.abort();
  }

  runningCall(): ToolCallPart | undefined {
    return this.running;
  }

  reportToolOutput(chunk: string): void {
    const callId = this.running?.callId;
    this.bus.emit("tool.output", { chunk, ...(callId !== undefined && { callId }) });
  }

  send(userText: string, options: SendOptions = {}): Promise<Message> {
    if (this.idle()) return this.runTurn(userText, options.signal);
    const behavior = options.behavior ?? "queue";
    const settled = this.enqueue(userText, behavior, options.signal);
    if (behavior === "steer") this.active?.abort();
    return settled;
  }

  settleTurnsWith(settler: TurnSettler | undefined): void {
    this.settler = settler;
  }

  hold(work: () => Promise<void>): Promise<void> {
    if (!this.idle()) return Promise.reject(new Error("agent busy · finish the turn first"));
    return this.holdThenDrain(work);
  }

  adoptQueue(from: Agent): void {
    if (from === this) return;
    const moved = from.pending.splice(0);
    if (moved.length === 0) return;
    from.announceQueue();
    this.pending.push(...moved);
    this.announceQueue();
    if (this.idle()) this.startNextQueued();
  }

  cancelQueued(id: string): boolean {
    const index = this.pending.findIndex((prompt) => prompt.id === id);
    if (index === -1) return false;
    for (const cancelled of this.pending.splice(index, 1)) {
      cancelled.reject(new QueuedPromptCancelledError(id));
    }
    this.announceQueue();
    return true;
  }

  private enqueue(
    text: string,
    behavior: SendBehavior,
    signal: AbortSignal | undefined,
  ): Promise<Message> {
    return new Promise((resolve, reject) => {
      const prompt: PendingPrompt = {
        id: crypto.randomUUID(),
        text,
        behavior,
        signal,
        resolve,
        reject,
      };
      this.pending.splice(this.queuePositionFor(behavior), 0, prompt);
      this.announceQueue();
    });
  }

  private queuePositionFor(behavior: SendBehavior): number {
    if (behavior === "queue") return this.pending.length;
    return this.pending.findLastIndex((prompt) => prompt.behavior === "steer") + 1;
  }

  private idle(): boolean {
    return this.active === undefined && !this.holding;
  }

  private startNextQueued(): void {
    const next = this.pending.shift();
    if (next === undefined) return;
    this.announceQueue();
    void this.runTurn(next.text, next.signal).then(next.resolve, next.reject);
  }

  private async holdThenDrain(work: () => Promise<void>): Promise<void> {
    this.holding = true;
    try {
      await work();
    } finally {
      this.holding = false;
      this.startNextQueued();
    }
  }

  private settleThenDrain(): Promise<void> {
    return this.holdThenDrain(async () => {
      try {
        await this.settler?.();
      } catch (cause) {
        this.bus.emit("engine.error", { error: errorOf(cause) });
      }
    });
  }

  private announceQueue(): void {
    this.bus.emit("queue.changed", { queued: this.queued() });
  }

  private async runTurn(userText: string, signal: AbortSignal | undefined): Promise<Message> {
    const controller = new AbortController();
    this.active = controller;
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      this.checkpointed = false;
      this.messages.push(textMessage("user", userText));
      this.announceStandingInjections();
      this.bus.emit("turn.started", { userText });
      return await (this.turns === undefined
        ? this.runUntilFinalMessage(controller.signal)
        : this.runDelegatedTurn(this.turns, userText, controller.signal));
    } catch (cause) {
      const error = errorOf(cause);
      this.bus.emit("engine.error", { error });
      throw error;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
      this.active = undefined;
      await this.settleThenDrain();
    }
  }

  private async runUntilFinalMessage(signal: AbortSignal): Promise<Message> {
    while (true) {
      const turn = await this.streamAssistantTurn(signal);
      this.totals = addUsage(this.totals, turn.usage);
      this.costTotals = withTurnCost(this.costTotals, turn.usage, this.provider.modelId);
      if (turn.failure !== undefined) {
        this.keepPartialMessage(turn.message);
        this.settleOrphanedToolCalls(turn.message);
        throw turn.failure;
      }
      if (turn.interrupted) {
        this.keepPartialMessage(turn.message);
        return this.finishInterrupted(turn.message);
      }
      this.messages.push(turn.message);

      const calls = toolCalls(turn.message);
      if (calls.length === 0) return this.finishCompleted(turn);
      await this.executeToolCalls(calls, signal);
      if (signal.aborted) return this.finishInterrupted(turn.message);
    }
  }

  private async runDelegatedTurn(
    delegate: TurnDelegate,
    userText: string,
    signal: AbortSignal,
  ): Promise<Message> {
    const outcome = await delegate({ userText, signal, bus: this.bus });
    this.totals = addUsage(this.totals, outcome.usage);
    this.costTotals = withTurnCost(this.costTotals, outcome.usage, this.provider.modelId);
    if (outcome.history === undefined) this.messages.push(outcome.message);
    else this.messages.splice(0, this.messages.length, ...outcome.history);
    if (outcome.interrupted) return this.finishInterrupted(outcome.message);
    return this.finishCompleted({ ...outcome, interrupted: false });
  }

  private finishCompleted(turn: AssistantTurn): Message {
    this.bus.emit("turn.completed", { message: turn.message, usage: turn.usage });
    return turn.message;
  }

  private finishInterrupted(message: Message): Message {
    this.settleOrphanedToolCalls(message);
    this.bus.emit("turn.interrupted", { message });
    return message;
  }

  private keepPartialMessage(message: Message): void {
    if (message.parts.length > 0) this.messages.push(message);
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

  private announceStandingInjections(): void {
    const injections = this.unannouncedInjections;
    this.unannouncedInjections = [];
    for (const injection of injections) this.bus.emit("context.injected", { injection });
  }

  private async streamAssistantTurn(signal: AbortSignal): Promise<AssistantTurn> {
    const message: Message = { role: "assistant", parts: [] };
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const request = {
      systemPrompt: this.systemPrompt,
      messages: [...this.messages],
      tools: this.tools(),
      ...(this.thinkingRequested && { thinking: true }),
      signal,
    };
    try {
      for await (const delta of this.provider.stream(request)) {
        this.bus.emit("turn.delta", { delta });
        usage = applyDelta(message, delta, usage);
      }
    } catch (cause) {
      if (signal.aborted) return { message, usage, interrupted: true };
      return { message, usage, interrupted: false, failure: errorOf(cause) };
    }
    return { message, usage, interrupted: false };
  }

  private async executeToolCalls(calls: ToolCallPart[], signal: AbortSignal): Promise<void> {
    for (const call of calls) {
      if (signal.aborted) return;
      this.bus.emit("tool.started", { call });
      this.running = call;
      const result = await this.bounded(await this.executeToolCall(call, signal));
      this.running = undefined;
      this.bus.emit("tool.finished", result);
      this.messages.push({
        role: "tool",
        parts: [{ type: "tool-result", ...result }],
      });
    }
  }

  private async bounded(outcome: ToolOutcome): Promise<ToolOutcome> {
    const spills = this.spills();
    if (spills === undefined) return outcome;
    const { output, spill } = await spills.keep(outcome.output);
    return { ...outcome, output, ...(spill !== undefined && { spill }) };
  }

  private async executeToolCall(call: ToolCallPart, signal: AbortSignal): Promise<ToolOutcome> {
    try {
      const tool = findTool(this.tools(), call.name);
      const policyVerdict = this.permissions?.(call);
      const verdict = policyVerdict ?? defaultPermission(tool);
      const gate = policyVerdict === undefined ? "default" : "policy";
      if (verdict === "deny") {
        this.emitPermissionDecision(call, "denied", gate);
        return { callId: call.callId, output: "denied by permission policy", isError: true };
      }
      if (verdict === "ask") {
        const guardAsked = this.guard?.confirm !== undefined;
        const approved = await this.confirmWithGuard(call);
        this.emitPermissionDecision(
          call,
          approved ? "granted" : "denied",
          guardAsked ? (this.guard?.gate ?? "user") : gate,
        );
        if (!approved) {
          return { callId: call.callId, output: declinedOutput(this.guard?.gate), isError: true };
        }
      } else {
        this.emitPermissionDecision(call, "granted", gate);
      }
      if (tool.mutates === true) await this.checkpointOnce();
      const remembered = tool.mutates === true ? await this.actionRecall?.(call) : undefined;
      const output = await tool.execute(call.arguments, signal);
      return {
        callId: call.callId,
        output: remembered === undefined ? output : `${output}\n\n${remembered}`,
        isError: false,
      };
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

function errorOf(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function toolSource(tools: readonly Tool[] | ToolSource | undefined): ToolSource {
  if (typeof tools === "function") return tools;
  const fixed = tools ?? [];
  return () => fixed;
}

function spillSource(spills: SpillStore | SpillSource | undefined): SpillSource {
  if (typeof spills === "function") return spills;
  return () => spills;
}

function defaultPermission(tool: Tool): ToolPermission {
  return tool.mutates === true ? "ask" : "allow";
}

function declinedOutput(gate: ConfirmingGate | undefined): string {
  return gate === "headless"
    ? "not approved: this run has no one to ask, so the call was refused"
    : "declined by user";
}

export function addUsage(left: Usage, right: Usage): Usage {
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
    case "visible-thinking":
      appendVisibleThinking(message, delta.text);
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

function appendVisibleThinking(message: Message, text: string): void {
  const last = message.parts.at(-1);
  if (last?.type === "visible-thinking") {
    last.text += text;
    return;
  }
  message.parts.push({ type: "visible-thinking", text });
}
