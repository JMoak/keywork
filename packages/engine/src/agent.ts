import { type AskScope, grantCandidates } from "@keywork/shared";
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
import {
  type ReportedContext,
  type RequestAnatomy,
  reportedContextOf,
} from "./session/context-map.ts";
import type {
  AskRule,
  ContextInjection,
  DenyReason,
  PermissionAsk,
  PermissionDecision,
  PermissionGate,
} from "./session/journal.ts";
import { clipToolOutput, type SpillStore } from "./session/spill.ts";
import { findTool, type Tool, type ToolPreview } from "./tools.ts";

export type ConfirmingGate = Extract<PermissionGate, "user" | "headless">;

export type Confirmation =
  | boolean
  | {
      approved: boolean;
      gate: ConfirmingGate;
      scope?: AskScope | undefined;
      reason?: PermissionDecision["reason"];
      note?: string | undefined;
      timedOut?: true;
    };

export interface ToolGuard {
  confirm?(call: ToolCallPart, ask?: PermissionAsk): Promise<Confirmation>;
  grantsQuietly?(call: ToolCallPart, rule: AskRule): boolean;
  gate?: ConfirmingGate;
  declineEndsRun?: boolean;
  beforeMutation?(): Promise<void>;
  beforeTurn?(): void;
}

export type ToolPermission = "allow" | "ask" | "deny";
export type QueueMove = "moved" | "unknown" | "out-of-range" | "crosses-steer";
export type GrantedScope = Exclude<AskScope, "once">;
export type PermissionRuling =
  | { permission: "allow"; gate: "user"; scope: GrantedScope }
  | { permission: ToolPermission; gate: Exclude<AskRule, "default"> };
export type PermissionResolver = (
  call: ToolCallPart,
) => ToolPermission | PermissionRuling | undefined;

export function rulingOf(
  verdict: ToolPermission | PermissionRuling | undefined,
): PermissionRuling | undefined {
  return typeof verdict === "string" ? { permission: verdict, gate: "policy" } : verdict;
}

export function permissionOf(
  verdict: ToolPermission | PermissionRuling | undefined,
): ToolPermission | undefined {
  return rulingOf(verdict)?.permission;
}

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
  promptInjections?: readonly string[];
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

export type TurnOpener = (prompt: Message) => Promise<string | undefined>;

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

export class NestedRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NestedRefusalError";
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
  private readonly promptInjections: readonly string[];
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
  private opener: TurnOpener | undefined;
  private settler: TurnSettler | undefined;
  private toolBatchSettler: ToolBatchSettler | undefined;
  private checkpointed = false;
  private declineEndedRun = false;
  private thinkingRequested: boolean;
  private effortRequested: EffortLevel | undefined;
  private readonly marks = new ConversationMarks();
  private previousResponseId: string | null = null;
  private turnCacheMiss: CacheMiss | undefined;
  private reported: ReportedContext | undefined;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.baseSystemPrompt = options.systemPrompt ?? "";
    this.systemPrompt = this.baseSystemPrompt;
    this.promptInjections = options.promptInjections ?? [];
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

  anatomy(): RequestAnatomy {
    return {
      systemPrompt: this.systemPrompt,
      injected: [
        ...this.promptInjections,
        hookedAddition(this.baseSystemPrompt, this.systemPrompt),
      ],
      tools: this.tools(),
      history: this.history(),
      reported: this.reported,
    };
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

  openTurnsWith(opener: TurnOpener | undefined): void {
    this.opener = opener;
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

  clearQueue(): readonly QueuedPrompt[] {
    const cleared = this.queued();
    for (const cancelled of this.pending.splice(0)) {
      cancelled.reject(new QueuedPromptCancelledError(cancelled.id));
    }
    if (cleared.length > 0) this.announceQueue();
    return cleared;
  }

  moveQueued(id: string, to: number): QueueMove {
    const from = this.pending.findIndex((prompt) => prompt.id === id);
    if (from === -1) return "unknown";
    if (!Number.isInteger(to) || to < 0 || to >= this.pending.length) return "out-of-range";
    const reordered = movedItem(this.pending, from, to);
    if (!steersLead(reordered)) return "crosses-steer";
    if (from === to) return "moved";
    this.pending.splice(0, this.pending.length, ...reordered);
    this.announceQueue();
    return "moved";
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
      const prompt = promptMessage(userText, images);
      this.remember(prompt);
      const entryId = this.opener === undefined ? undefined : await this.opener(prompt);
      this.announceStandingInjections();
      this.bus.emit("turn.started", {
        userText,
        ...(entryId !== undefined && { entryId }),
        ...(origin !== undefined && { origin }),
      });
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
      this.reported = reportedContextOf(turn.usage, this.messages.length) ?? this.reported;

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
      if (rebuilt !== undefined) this.replaceHistory(rebuilt);
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
      this.replaceHistory(outcome.history);
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

  private replaceHistory(messages: readonly Message[]): void {
    this.messages.splice(0, this.messages.length, ...messages);
    this.reported = undefined;
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
    if (spills === undefined) return { ...outcome, output: clipToolOutput(outcome.output) };
    const { output, spill } = await spills.keep(outcome.output);
    return { ...outcome, output, ...(spill !== undefined && { spill }) };
  }

  private async executeToolCall(call: ToolCallPart, signal: AbortSignal): Promise<ToolOutcome> {
    try {
      const tool = findTool(this.tools(), call.name);
      const ruling = this.rulingFor(call, tool);
      if (ruling.permission === "deny") {
        this.emitPermissionDecision(call, { verdict: "denied", gate: ruling.gate, asked: false });
        return { callId: call.callId, output: "denied by permission policy", isError: true };
      }
      if (ruling.permission === "ask") {
        const refusal = await this.refusalAfterAsking(call, tool, ruling.gate);
        if (refusal !== undefined) return refusal;
      } else {
        this.emitPermissionDecision(call, {
          verdict: "granted",
          gate: ruling.gate,
          asked: false,
          scope: scopeOf(ruling),
        });
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
      if (cause instanceof NestedRefusalError) {
        this.declineEndedRun = this.guard?.declineEndsRun === true;
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      return { callId: call.callId, output: reason, isError: true };
    }
  }

  private async refusalAfterAsking(
    call: ToolCallPart,
    tool: Tool,
    rule: AskRule,
  ): Promise<ToolOutcome | undefined> {
    if (this.guard?.grantsQuietly?.(call, rule) === true) {
      this.emitPermissionDecision(call, quietlyGranted);
      return undefined;
    }
    const ask = this.guard?.confirm === undefined ? undefined : await askAbout(call, tool, rule);
    if (ask !== undefined) this.bus.emit("gate.ask", { ask });
    const answer = await this.confirmWithGuard(call, ask);
    const answeredBy = answer.gate ?? this.guard?.gate ?? "user";
    this.emitPermissionDecision(call, {
      verdict: answer.approved ? "granted" : "denied",
      gate: ask === undefined ? rule : answeredBy,
      asked: ask !== undefined,
      scope: answer.scope,
      ...(!answer.approved && denialOf(answer)),
    });
    if (answer.approved) return undefined;
    this.declineEndedRun = this.guard?.declineEndsRun === true;
    return { callId: call.callId, output: declinedOutput(answer, answeredBy), isError: true };
  }

  private rulingFor(call: ToolCallPart, tool: Tool): GateRuling {
    return (
      rulingOf(this.permissions?.(call)) ?? { permission: defaultPermission(tool), gate: "default" }
    );
  }

  private emitPermissionDecision(call: ToolCallPart, ruled: RuledCall): void {
    this.bus.emit("gate.permission", {
      decision: {
        tool: call.name,
        callId: call.callId,
        verdict: ruled.verdict,
        gate: ruled.gate,
        ...(ruled.scope !== undefined && { scope: ruled.scope }),
        ...(ruled.reason !== undefined && { reason: ruled.reason }),
        ...(ruled.note !== undefined && { note: ruled.note }),
        asked: ruled.asked,
      },
    });
  }

  private async confirmWithGuard(
    call: ToolCallPart,
    ask: PermissionAsk | undefined,
  ): Promise<AnsweredConfirmation> {
    const answer = await (this.guard?.confirm?.(call, ask) ?? Promise.resolve(true));
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

async function askAbout(call: ToolCallPart, tool: Tool, rule: AskRule): Promise<PermissionAsk> {
  const preview = await bestEffortPreview(tool, call);
  return {
    tool: call.name,
    callId: call.callId,
    arguments: call.arguments,
    rule,
    rules: grantCandidates(call.name, call.arguments),
    ...(preview !== undefined && { preview }),
  };
}

async function bestEffortPreview(tool: Tool, call: ToolCallPart): Promise<ToolPreview | undefined> {
  try {
    return await tool.preview?.(call.arguments);
  } catch {
    return undefined;
  }
}

function hookedAddition(base: string, hooked: string): string {
  return hooked.startsWith(base) ? hooked.slice(base.length) : "";
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

type GateRuling = PermissionRuling | { permission: ToolPermission; gate: "default" };

interface RuledCall {
  verdict: PermissionDecision["verdict"];
  gate: PermissionDecision["gate"];
  asked: boolean;
  scope?: AskScope | undefined;
  reason?: PermissionDecision["reason"];
  note?: string | undefined;
}

interface AnsweredConfirmation {
  approved: boolean;
  gate: ConfirmingGate | undefined;
  scope?: AskScope | undefined;
  reason?: PermissionDecision["reason"];
  note?: string | undefined;
  timedOut?: true;
}

const quietlyGranted: RuledCall = {
  verdict: "granted",
  gate: "quiet",
  asked: false,
  scope: "session",
};

function movedItem<Item>(items: readonly Item[], from: number, to: number): Item[] {
  const reordered = [...items];
  const [item] = reordered.splice(from, 1);
  if (item !== undefined) reordered.splice(to, 0, item);
  return reordered;
}

function steersLead(prompts: readonly QueuedPrompt[]): boolean {
  const firstQueued = prompts.findIndex((prompt) => prompt.behavior === "queue");
  return (
    firstQueued === -1 || prompts.slice(firstQueued).every(({ behavior }) => behavior === "queue")
  );
}

function scopeOf(ruling: GateRuling): GrantedScope | undefined {
  return ruling.gate === "user" ? ruling.scope : undefined;
}

function defaultPermission(tool: Tool): ToolPermission {
  return tool.mutates === true ? "ask" : "allow";
}

function refusedByExtension(call: ToolCallPart, reason: string): ToolOutcome {
  return { callId: call.callId, output: `refused by extension ${reason}`, isError: true };
}

function denialOf({ reason, note }: AnsweredConfirmation): Pick<RuledCall, "reason" | "note"> {
  return {
    ...(reason !== undefined && { reason }),
    ...(note !== undefined && { note }),
  };
}

function declinedOutput(answer: AnsweredConfirmation, gate: ConfirmingGate): string {
  const said = answer.note === undefined ? [] : [`The user said: "${answer.note}"`];
  return [refusalOf(answer, gate), ...said, declineIsFinal].join("\n");
}

function refusalOf(answer: AnsweredConfirmation, gate: ConfirmingGate): string {
  if (answer.timedOut === true) return unansweredRefusal;
  return gate === "headless" ? unattendedRefusal : declinedBecause(answer.reason);
}

function declinedBecause(reason: DenyReason | undefined): string {
  return reason === undefined ? "declined by user" : declineReasons[reason];
}

const unattendedRefusal = "not approved: this run has no one to ask, so the call was refused";

const unansweredRefusal =
  "not approved: nobody answered the ask in time, so the person probably stepped away and the call was refused";

const declineReasons: Readonly<Record<DenyReason, string>> = {
  unsafe: "declined by user · they judged this call unsafe",
  "not-now": "declined by user · not now, though the call itself may be fine later",
  other: "declined by user",
};

const declineIsFinal =
  "The call did not run, so nothing it would have changed was changed. Do not retry it or a variant of it unless the user asks you to, and never report it as done.";

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
