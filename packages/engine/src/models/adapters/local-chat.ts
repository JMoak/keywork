import type { Message, ToolCallPart } from "../../messages.ts";
import {
  assertRequestControls,
  type Provider,
  type ProviderRequest,
  type TurnDelta,
} from "../../provider.ts";
import { toChatRequest } from "../../providers/chat-wire.ts";
import { ProviderStreamError } from "../../providers/errors.ts";
import { sseJsonEvents } from "../../providers/sse.ts";
import { bearerHeaders, postForStream } from "../../providers/transport.ts";
import { ToolCallAssembler } from "../../providers/wire-parts.ts";
import { normalizeUsage } from "../ledger/normalize.ts";
import { toKeyworkUsage } from "../ledger/usage.ts";
import { joinUrl } from "./http.ts";
import { arrayAt, isRecord, objectAt, stringAt } from "./json.ts";
import { type Body, withoutFields, withStagedRetry } from "./staged-retry.ts";
import type { ChatOptions, ServerDeltas, ToolChoice } from "./types.ts";

export class ToolChoiceUnmetError extends Error {
  constructor(
    readonly choice: ToolChoice,
    readonly called: readonly string[],
  ) {
    super(
      `tool choice "${describeChoice(choice)}" was not met: the model called ${called.length === 0 ? "no tool" : called.join(", ")}`,
    );
    this.name = "ToolChoiceUnmetError";
  }
}

export function localChatProvider(deltas: ServerDeltas, options: ChatOptions): Provider {
  return new LocalChatProvider(deltas, options);
}

export interface ChatPlan {
  body: Body;
  optionalFields: readonly string[];
  enforce: ToolChoice | undefined;
}

export function chatPlan(
  request: ProviderRequest,
  options: ChatOptions,
  deltas: ServerDeltas,
): ChatPlan {
  const base = toChatRequest(request, options.model) as Record<string, unknown>;
  const messages =
    options.replayReasoning === true
      ? withReasoningReplay(arrayAt(base, "messages"), request.messages)
      : base.messages;
  const choice = toolChoicePlan(options.toolChoice, deltas.honoredToolChoice, request.tools.length);
  const optional = optionalFieldsFor(options, deltas);
  const body = withoutFields({ ...base, messages, ...choice.fields, ...optional }, [
    ...choice.strip,
    ...deltas.droppedChatFields,
  ]);
  return { body, optionalFields: Object.keys(optional), enforce: choice.enforce };
}

class LocalChatProvider implements Provider {
  readonly name: string;
  readonly modelId: string;
  private readonly now: () => number;

  constructor(
    private readonly deltas: ServerDeltas,
    private readonly options: ChatOptions,
  ) {
    this.name = options.name;
    this.modelId = options.model;
    this.now = options.now ?? Date.now;
  }

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    assertRequestControls(this, request);
    const started = this.now();
    const plan = chatPlan(request, this.options, this.deltas);
    const stream = await withStagedRetry(
      (body) => this.post(body, request.signal),
      plan.body,
      plan.optionalFields,
      this.options.fieldMemory,
    );
    yield* this.assemble(stream, plan, started);
  }

  private async post(
    body: Body,
    signal: AbortSignal | undefined,
  ): Promise<ReadableStream<Uint8Array>> {
    const authHeaders = this.options.authHeaders ?? bearerHeaders(undefined);
    return postForStream(this.name, this.options.fetchFn ?? fetch, {
      url: joinUrl(this.options.root, "/v1/chat/completions"),
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async *assemble(
    stream: ReadableStream<Uint8Array>,
    plan: ChatPlan,
    started: number,
  ): AsyncGenerator<TurnDelta> {
    const calls = new ToolCallAssembler(this.name);
    const turn: TurnTrace = { usage: undefined, timings: undefined, servedModel: null };
    let firstAt: number | undefined;
    for await (const event of sseJsonEvents(this.name, stream)) {
      traceEvent(this.name, turn, event);
      const delta = objectAt(arrayAt(event, "choices")[0], "delta");
      for (const text of reasoningTexts(delta, this.deltas.reasoningDeltaFields)) {
        firstAt ??= this.now();
        yield { type: "visible-thinking", text };
      }
      const content = stringAt(delta, "content");
      if (content !== undefined && content !== "") {
        firstAt ??= this.now();
        yield { type: "text", text: content };
      }
      for (const fragment of arrayAt(delta, "tool_calls")) {
        firstAt ??= this.now();
        addFragment(calls, fragment);
      }
    }
    const finished = this.now();
    const usage = normalizeUsage(
      this.deltas.usageShape,
      { usage: turn.usage, timings: turn.timings },
      {
        model: this.modelId,
        measured: {
          ...(firstAt !== undefined && { msTtft: firstAt - started }),
          msTotal: finished - started,
        },
      },
    );
    this.options.onUsage?.({ usage, servedModel: turn.servedModel });
    const completed = calls.completed();
    if (plan.enforce !== undefined) assertToolChoiceMet(plan.enforce, completed);
    for (const call of completed) yield { type: "tool-call", call };
    yield { type: "done", usage: toKeyworkUsage(usage) };
  }
}

interface TurnTrace {
  usage: unknown;
  timings: unknown;
  servedModel: string | null;
}

function traceEvent(provider: string, turn: TurnTrace, event: unknown): void {
  if (!isRecord(event)) return;
  if (event.error != null) throw new ProviderStreamError(provider, describeError(event.error));
  if (isRecord(event.usage)) turn.usage = event.usage;
  if (isRecord(event.timings)) turn.timings = event.timings;
  turn.servedModel = stringAt(event, "model") ?? turn.servedModel;
}

function reasoningTexts(delta: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields
    .map((field) => stringAt(delta, field))
    .filter((text): text is string => text !== undefined && text !== "");
}

function addFragment(calls: ToolCallAssembler, fragment: unknown): void {
  const index = isRecord(fragment) && typeof fragment.index === "number" ? fragment.index : 0;
  calls.add(index, {
    id: stringAt(fragment, "id"),
    name: stringAt(fragment, "function", "name"),
    argumentsJson: stringAt(fragment, "function", "arguments"),
  });
}

interface ToolChoicePlan {
  fields: Body;
  strip: readonly string[];
  enforce: ToolChoice | undefined;
}

function toolChoicePlan(
  choice: ToolChoice | undefined,
  honored: readonly string[] | null,
  toolCount: number,
): ToolChoicePlan {
  const nothing: ToolChoicePlan = { fields: {}, strip: [], enforce: undefined };
  if (choice === undefined || choice.mode === "auto" || toolCount === 0) return nothing;
  if (honored?.includes(choice.mode) === true) {
    return { fields: { tool_choice: toolChoiceWire(choice) }, strip: [], enforce: undefined };
  }
  if (choice.mode === "none") return { fields: {}, strip: ["tools"], enforce: undefined };
  return { fields: {}, strip: [], enforce: choice };
}

function toolChoiceWire(choice: Exclude<ToolChoice, { mode: "auto" }>): unknown {
  return choice.mode === "named"
    ? { type: "function", function: { name: choice.name } }
    : choice.mode;
}

function assertToolChoiceMet(choice: ToolChoice, calls: readonly ToolCallPart[]): void {
  const called = calls.map((call) => call.name);
  const met =
    choice.mode === "required"
      ? called.length > 0
      : choice.mode === "named"
        ? called.length > 0 && called.every((name) => name === choice.name)
        : true;
  if (!met) throw new ToolChoiceUnmetError(choice, called);
}

function optionalFieldsFor(options: ChatOptions, deltas: ServerDeltas): Body {
  return Object.fromEntries(
    Object.entries(options.optionalFields ?? {}).filter(
      ([field]) =>
        options.fieldMemory?.rejects(field) !== true && !deltas.droppedChatFields.includes(field),
    ),
  );
}

function withReasoningReplay(wire: readonly unknown[], source: readonly Message[]): unknown[] {
  const reasoning = source.filter((message) => message.role === "assistant").map(reasoningOf);
  let assistantIndex = 0;
  return wire.map((message) => {
    if (!isRecord(message) || message.role !== "assistant") return message;
    const text = reasoning[assistantIndex++] ?? "";
    return text === "" ? message : { ...message, reasoning_content: text };
  });
}

function reasoningOf(message: Message): string {
  return message.parts.map((part) => (part.type === "visible-thinking" ? part.text : "")).join("");
}

function describeChoice(choice: ToolChoice): string {
  return choice.mode === "named" ? `named:${choice.name}` : choice.mode;
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  return stringAt(error, "message") ?? JSON.stringify(error);
}
