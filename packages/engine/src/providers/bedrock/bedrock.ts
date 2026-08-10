import type { ImagePart, Message, Part, ToolCallPart, Usage } from "../../messages.ts";
import { messageText } from "../../messages.ts";
import type { Provider, ProviderRequest, ToolDefinition, TurnDelta } from "../../provider.ts";
import { type FetchLike, ProviderHttpError, ProviderStreamError } from "../openai.ts";
import { type EventStreamMessage, eventStreamMessages } from "./eventstream.ts";
import { type AwsCredentials, rfc3986Encode, signRequest } from "./sigv4.ts";

export interface BedrockOptions {
  region: string;
  model: string;
  credentials: AwsCredentials;
  fetchFn?: FetchLike;
  clock?: () => Date;
}

const awsRegionPattern = /^[a-z]{2}(-[a-z]+)+-\d+$/;

export class BedrockExceptionError extends Error {
  readonly transient: boolean;

  constructor(
    provider: string,
    readonly exceptionType: string,
    detail: string,
  ) {
    super(`${provider} stream exception (${exceptionType}): ${detail.slice(0, 500)}`);
    this.name = "BedrockExceptionError";
    this.transient = transientExceptionTypes.has(exceptionType);
  }
}

export class BedrockProvider implements Provider {
  readonly name = "bedrock";
  private readonly options: Required<BedrockOptions>;

  constructor(options: BedrockOptions) {
    if (!awsRegionPattern.test(options.region)) {
      throw new Error(`bedrock region must look like us-east-1, got "${options.region}"`);
    }
    this.options = { fetchFn: fetch, clock: () => new Date(), ...options };
  }

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    const url = new URL(
      `https://bedrock-runtime.${this.options.region}.amazonaws.com` +
        `/model/${rfc3986Encode(this.options.model)}/converse-stream`,
    );
    const body = JSON.stringify(toConverseRequest(request));
    const headers = signRequest({
      method: "POST",
      url,
      headers: { "content-type": "application/json", accept: "application/vnd.amazon.eventstream" },
      body,
      region: this.options.region,
      service: "bedrock",
      credentials: this.options.credentials,
      now: this.options.clock(),
    });
    const response = await this.options.fetchFn(url.toString(), {
      method: "POST",
      headers,
      body,
      ...(request.signal !== undefined && { signal: request.signal }),
    });
    if (!response.ok) {
      throw new ProviderHttpError(this.name, response.status, await response.text());
    }
    if (response.body === null) throw new Error(`${this.name} returned an empty response body`);
    yield* assembleTurn(this.name, eventStreamMessages(this.name, response.body));
  }
}

const transientExceptionTypes = new Set([
  "throttlingException",
  "serviceUnavailableException",
  "modelStreamErrorException",
  "internalServerException",
]);

const maxToolInputBytes = 1_048_576;

function toConverseRequest(request: ProviderRequest): object {
  const system = [
    ...(request.systemPrompt === "" ? [] : [{ text: request.systemPrompt }]),
    ...request.messages
      .filter((message) => message.role === "system")
      .map((message) => ({ text: messageText(message) })),
  ];
  return {
    ...(system.length > 0 && { system }),
    messages: request.messages.flatMap(converseMessage),
    ...(request.tools.length > 0 && {
      toolConfig: { tools: request.tools.map(converseTool) },
    }),
  };
}

function converseMessage(message: Message): object[] {
  if (message.role === "system") return [];
  const content = message.parts.flatMap(converseBlock);
  if (content.length === 0) return [];
  return [{ role: message.role === "assistant" ? "assistant" : "user", content }];
}

function converseBlock(part: Part): object[] {
  switch (part.type) {
    case "text":
      return [{ text: part.text }];
    case "image":
      return [{ image: { format: imageFormat(part), source: { bytes: part.data } } }];
    case "tool-call":
      return [{ toolUse: { toolUseId: part.callId, name: part.name, input: part.arguments } }];
    case "tool-result":
      return [
        {
          toolResult: {
            toolUseId: part.callId,
            content: [{ text: part.output }],
            ...(part.isError && { status: "error" }),
          },
        },
      ];
    case "thinking":
    case "redacted-thinking":
      return [];
  }
}

function imageFormat(part: ImagePart): string {
  return part.mediaType.replace(/^image\//, "");
}

function converseTool(tool: ToolDefinition): object {
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters },
    },
  };
}

interface ConverseStreamEvent {
  contentBlockIndex?: number;
  start?: { toolUse?: { toolUseId?: string; name?: string } };
  delta?: { text?: string; toolUse?: { input?: string } };
  usage?: { inputTokens?: number; outputTokens?: number };
}

interface PendingToolUse {
  id: string;
  name: string;
  inputJson: string;
}

async function* assembleTurn(
  provider: string,
  frames: AsyncIterable<EventStreamMessage>,
): AsyncGenerator<TurnDelta> {
  const pending = new Map<number, PendingToolUse>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  for await (const frame of frames) {
    const event = decodeEvent(provider, frame);
    if (event.usage !== undefined) {
      usage = {
        inputTokens: event.usage.inputTokens ?? 0,
        outputTokens: event.usage.outputTokens ?? 0,
      };
    }
    if (typeof event.delta?.text === "string" && event.delta.text !== "") {
      yield { type: "text", text: event.delta.text };
    }
    const index = event.contentBlockIndex ?? 0;
    const startedToolUse = event.start?.toolUse;
    if (startedToolUse !== undefined) {
      pending.set(index, {
        id: startedToolUse.toolUseId ?? "",
        name: startedToolUse.name ?? "",
        inputJson: "",
      });
    }
    const inputFragment = event.delta?.toolUse?.input;
    if (typeof inputFragment === "string") accumulate(provider, pending, index, inputFragment);
  }
  for (const [index, toolUse] of [...pending].sort(([a], [b]) => a - b)) {
    yield { type: "tool-call", call: completedCall(index, toolUse) };
  }
  yield { type: "done", usage };
}

function decodeEvent(provider: string, frame: EventStreamMessage): ConverseStreamEvent {
  const messageType = frame.headers[":message-type"];
  if (messageType === "exception") {
    const exceptionType = frame.headers[":exception-type"] ?? "unknownException";
    throw new BedrockExceptionError(provider, exceptionType, exceptionDetail(frame));
  }
  if (messageType !== "event") {
    throw new ProviderStreamError(provider, `unexpected message type "${messageType ?? ""}"`);
  }
  const payload = parsePayload(frame);
  if (typeof payload !== "object" || payload === null) {
    throw new ProviderStreamError(provider, "event payload is not a JSON object");
  }
  return payload as ConverseStreamEvent;
}

function exceptionDetail(frame: EventStreamMessage): string {
  const payload = parsePayload(frame);
  const message = (payload as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : new TextDecoder().decode(frame.payload);
}

function parsePayload(frame: EventStreamMessage): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(frame.payload));
  } catch {
    return null;
  }
}

function accumulate(
  provider: string,
  pending: Map<number, PendingToolUse>,
  index: number,
  fragment: string,
): void {
  const existing = pending.get(index) ?? { id: "", name: "", inputJson: "" };
  const inputJson = existing.inputJson + fragment;
  if (inputJson.length > maxToolInputBytes) {
    throw new ProviderStreamError(provider, "tool-use input exceeded the size ceiling");
  }
  pending.set(index, { ...existing, inputJson });
}

function completedCall(index: number, toolUse: PendingToolUse): ToolCallPart {
  return {
    type: "tool-call",
    callId: toolUse.id !== "" ? toolUse.id : `call_${index}`,
    name: toolUse.name,
    arguments: parseInput(toolUse.inputJson),
  };
}

function parseInput(inputJson: string): unknown {
  if (inputJson.trim() === "") return {};
  try {
    return JSON.parse(inputJson);
  } catch {
    return inputJson;
  }
}
