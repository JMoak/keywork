import {
  type AgentHooks,
  proceedWith,
  type ToolCallRuling,
  toolsThroughHooks,
} from "./agent-hooks.ts";
import {
  type EngineEvents,
  EventBus,
  type PromptOrigin,
  type QueuedPrompt,
  type SendBehavior,
} from "./bus.ts";
import {
  type ImagePart,
  type Message,
  promptMessage,
  type ToolCallPart,
  toolCalls,
  type Usage,
} from "./messages.ts";
import { type CostRollup, emptyCostRollup, withTurnCost } from "./pricing.ts";
import type {
  CacheMiss,
  DoneDelta,
  EffortLevel,
  Provider,
  ProviderRequest,
  TurnDelta,
} from "./provider.ts";
import { ConversationMarks } from "./request-marks.ts";
import type {
  AskRule,
  ContextInjection,
  PermissionDecision,
  PermissionGate,
} from "./session/journal.ts";
import type { SpillStore } from "./session/spill.ts";
import { findTool, type Tool } from "./tools.ts";

export type ConfirmingGate = Extract<PermissionGate, "user" | "headless">;

export type Confirmation = boolean | { approved: boolean; gate: ConfirmingGate };

export interface ToolGuard {
  confirm?(call: ToolCallPart): Promise<Confirmation>;
  gate?: ConfirmingGate;
  declineEndsRun?: boolean;
  beforeMutation?(): Promise<void>;
  beforeTurn?(): void;
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
  hooks?: AgentHooks;
  bus?: EventBus<EngineEvents>;
  history?: readonly Message[];
  guard?: ToolGuard;
  permissions?: PermissionResolver;
  standingInjections?: readonly ContextInjection[];
  actionRecall?: ActionRecall;
  thinking?: boolean;
  effort?: EffortLevel;
  spills?: SpillStore | SpillSource;
}

export interface SendOptions {
  behavior?: SendBehavior;
  signal?: AbortSignal;
  origin?: PromptOrigin;
  images?: readonly ImagePart[];
}

export type TurnSettler = () => Promise<void>;

export type ToolBatchSettler = (
  history: readonly Message[],
) => Promise<readonly Message[] | undefined>;

export class QueuedPromptCancelledError extends Error {
  constructor(id: string) {
    super(`queued prompt ${id} was cancelled before its turn`);
    this.name = "QueuedPromptCancelledError";
  }
}

interface PendingPrompt extends QueuedPrompt {
  images: readonly ImagePart[];
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
  private readonly baseSystemPrompt: string;
  private systemPrompt: string;
  private readonly hooks: AgentHooks;
  private readonly tools: ToolSource;
  private readonly messages: Message[];
  private readonly guard: ToolGuard | undefined;
  private readonly permissions: PermissionResolver | undefined;
  private readonly actionRecall: ActionRecall | undefined;
  private readonly spills: SpillSource;
  private readonly turns: TurnDelegate | undefined;
  private readonly pending: PendingPrompt[] = [];
  private running: ToolCallPart | undefined;
  private origin: PromptOrigin | undefined;
  private unannouncedInjections: readonly ContextInjection[];
  private totals: Usage = { inputTokens: 0, outputTokens: 0 };
  private costTotals: CostRollup = emptyCostRollup();
  private active: AbortController | undefined;
  private holding = false;
  private settler: TurnSettler | undefined;
  private toolBatchSettler: ToolBatchSettler | undefined;
  private checkpointed = false;
  private declineEndedRun = false;
  private thinkingRequested: boolean;
  private effortRequested: EffortLevel | undefined;
  private readonly marks = new ConversationMarks();
  private previousResponseId: string | null = null;
  private turnCacheMiss: CacheMiss | undefined;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.baseSystemPrompt = options.systemPrompt ?? "";
    this.systemPrompt = this.baseSystemPrompt;
    this.hooks = options.hooks ?? {};
    this.tools = toolsThroughHooks(toolSource(options.tools), this.hooks);
    this.bus = options.bus ?? new EventBus();
    this.messages = [...(options.history ?? [])];
    this.guard = options.guard;
    this.permissions = options.permissions;
    this.actionRecall = options.actionRecall;
    this.spills = spillSource(options.spills);
    this.turns = options.turns;
    this.unannouncedInjections = options.standingInjections ?? [];
    this.thinkingRequested = options.thinking ?? false;
    this.effortRequested = options.effort;
  }

  thinking(): boolean {
    return this.thinkingRequested;
  }

  setThinking(requested: boolean): void {
    this.thinkingRequested = requested;
  }

  effort(): EffortLevel | undefined {
    return this.effortRequested;
  }

  setEffort(level: EffortLevel): void {
    this.effortRequested = level;
  }

  cacheMiss(): CacheMiss | undefined {
    return this.turnCacheMiss;
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
    return this.pending.map(({ id, text, behavior, origin }) => ({
      id,
      text,
      behavior,
      ...(origin !== undefined && { origin }),
    }));
  }

  interrupt(): void {
    this.active?.abort();
  }

  runningCall(): ToolCallPart | undefined {
    return this.running;
  }

  turnOrigin(): PromptOrigin | undefined {
    return this.origin;
  }

  reportToolOutput(chunk: string): void {
    const callId = this.running?.callId;
    this.bus.emit("tool.output", { chunk, ...(callId !== undefined && { callId }) });
  }

  send(userText: string, options: SendOptions = {}): Promise<Message> {
    const images = options.images ?? [];
    if (this.idle()) return this.runTurn(userText, options.signal, options.origin, images);
    const behavior = options.behavior ?? "queue";
    const settled = this.enqueue(userText, behavior, options.signal, options.origin, images);
    if (behavior === "steer") this.active?.abort();
    return settled;
  }

  settleTurnsWith(settler: TurnSettler | undefined): void {
    this.settler = settler;
  }

  settleToolBatchesWith(settler: ToolBatchSettler | undefined): void {
    this.toolBatchSettler = settler;
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
    origin: PromptOrigin | undefined,
    images: readonly ImagePart[],
  ): Promise<Message> {
    return new Promise((resolve, reject) => {
      const prompt: PendingPrompt = {
        id: crypto.randomUUID(),
        text,
        behavior,
        ...(origin !== undefined && { origin }),
        images,
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
    void this.runTurn(next.text, next.signal, next.origin, next.images).then(
      next.resolve,
      next.reject,
    );
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

  private async runTurn(
    userText: string,
    signal: AbortSignal | undefined,
    origin?: PromptOrigin,
    images: readonly ImagePart[] = [],
  ): Promise<Message> {
    const controller = new AbortController();
    this.active = controller;
    this.origin = origin;
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      this.checkpointed = false;
      this.guard?.beforeTurn?.();
      this.turnCacheMiss = undefined;
      this.marks.restateEffort(this.effortRequested, this.messages.length);
      this.remember(promptMessage(userText, images));
      this.announceStandingInjections();
      this.bus.emit("turn.started", { userText, ...(origin !== undefined && { origin }) });
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
      this.origin = undefined;
      await this.settleThenDrain();
    }
  }

  private async runUntilFinalMessage(signal: AbortSignal): Promise<Message> {
    while (true) {
      this.systemPrompt = await this.systemPromptThroughHooks();
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
      this.remember(turn.message);

      const calls = toolCalls(turn.message);
      if (calls.length === 0) return this.finishCompleted(turn);
      const ending = await this.executeToolCalls(calls, signal);
      if (signal.aborted) return this.finishInterrupted(turn.message);
      if (ending === "declined") return this.finishDeclined(turn);
      await this.settleToolBatch();
    }
  }

  private async settleToolBatch(): Promise<void> {
    const settler = this.toolBatchSettler;
    if (settler === undefined) return;
    try {
      const rebuilt = await settler(this.history());
      if (rebuilt !== undefined) this.messages.splice(0, this.messages.length, ...rebuilt);
    } catch (cause) {
      this.bus.emit("engine.error", { error: errorOf(cause) });
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
    if (outcome.history === undefined) this.remember(outcome.message);
    else {
      this.messages.splice(0, this.messages.length, ...outcome.history);
      this.hooks.messageAppended?.(outcome.message);
    }
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

  private finishDeclined(turn: AssistantTurn): Message {
    this.settleOrphanedToolCalls(turn.message, "skipped: the run ended at a refused call");
    return this.finishCompleted(turn);
  }

  private keepPartialMessage(message: Message): void {
    if (message.parts.length > 0) this.remember(message);
  }

  private settleOrphanedToolCalls(message: Message, output = "interrupted before execution"): void {
    const settled = this.settledCallIds();
    for (const call of toolCalls(message)) {
      if (settled.has(call.callId)) continue;
      this.remember({
        role: "tool",
        parts: [{ type: "tool-result", callId: call.callId, output, isError: true }],
      });
    }
  }

  private remember(message: Message): void {
    this.messages.push(message);
    this.hooks.messageAppended?.(message);
  }

  private systemPromptThroughHooks(): Promise<string> {
    return (
      this.hooks.systemPrompt?.(this.baseSystemPrompt) ?? Promise.resolve(this.baseSystemPrompt)
    );
  }

  private ruleOnToolCall(call: ToolCallPart): Promise<ToolCallRuling> {
    return this.hooks.toolCall?.(call) ?? Promise.resolve(proceedWith(call));
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
    const tools = this.tools();
    const request: ProviderRequest = {
      systemPrompt: this.systemPrompt,
      messages: [...this.messages],
      tools,
      ...(this.thinkingRequested && { thinking: true }),
      ...this.marks.forRequest(tools, this.effortRequested, this.messages.length),
      cacheDiagnostics: { previousResponseId: this.previousResponseId },
      signal,
    };
    try {
      for await (const delta of this.provider.stream(request)) {
        this.bus.emit("turn.delta", { delta });
        if (delta.type === "done") this.noteResponse(delta);
        usage = applyDelta(message, delta, usage);
      }
    } catch (cause) {
      if (signal.aborted) return { message, usage, interrupted: true };
      return { message, usage, interrupted: false, failure: errorOf(cause) };
    }
    return { message, usage, interrupted: false };
  }

  private noteResponse(done: DoneDelta): void {
    if (done.responseId !== undefined) this.previousResponseId = done.responseId;
    if (done.cacheMiss !== undefined) this.turnCacheMiss = done.cacheMiss;
  }

  private async executeToolCalls(
    calls: ToolCallPart[],
    signal: AbortSignal,
  ): Promise<"continue" | "declined"> {
    this.declineEndedRun = false;
    for (const requested of calls) {
      if (signal.aborted) return "continue";
      const ruling = await this.ruleOnToolCall(requested);
      const call = ruling.kind === "proceed" ? ruling.call : requested;
      this.bus.emit("tool.started", { call });
      this.running = call;
      const result = await this.bounded(
        ruling.kind === "refuse"
          ? refusedByExtension(call, ruling.reason)
          : await this.executeToolCall(call, signal),
      );
      this.running = undefined;
      this.bus.emit("tool.finished", result);
      this.remember({
        role: "tool",
        parts: [{ type: "tool-result", ...result }],
      });
      if (this.declineEndedRun) return "declined";
    }
    return "continue";
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
        if (guardAsked) this.emitAsk(call, gate);
        const answer = await this.confirmWithGuard(call);
        const answeredBy = answer.gate ?? this.guard?.gate ?? "user";
        this.emitPermissionDecision(
          call,
          answer.approved ? "granted" : "denied",
          guardAsked ? answeredBy : gate,
        );
        if (!answer.approved) {
          this.declineEndedRun = this.guard?.declineEndsRun === true;
          return { callId: call.callId, output: declinedOutput(answeredBy), isError: true };
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

  private emitAsk(call: ToolCallPart, rule: AskRule): void {
    this.bus.emit("gate.ask", {
      ask: { tool: call.name, callId: call.callId, arguments: call.arguments, rule },
    });
  }

  private async confirmWithGuard(
    call: ToolCallPart,
  ): Promise<{ approved: boolean; gate: ConfirmingGate | undefined }> {
    const answer = await (this.guard?.confirm?.(call) ?? Promise.resolve(true));
    return typeof answer === "boolean" ? { approved: answer, gate: undefined } : answer;
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

function refusedByExtension(call: ToolCallPart, reason: string): ToolOutcome {
  return { callId: call.callId, output: `refused by extension ${reason}`, isError: true };
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
    case "progress":
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
