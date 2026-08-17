import type { ToolCallPart, Usage } from "./messages.ts";
import type { Provider, ProviderRequest, TurnDelta } from "./provider.ts";

const zeroUsage: Usage = { inputTokens: 0, outputTokens: 0 };

export class MockProvider implements Provider {
  readonly name = "mock";
  readonly modelId: string | undefined;
  private readonly script: TurnDelta[][];

  constructor(turns: TurnDelta[][], modelId?: string) {
    this.script = [...turns];
    this.modelId = modelId;
  }

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    const turn = this.script.shift();
    if (turn === undefined) {
      throw new Error("MockProvider script exhausted: unexpected extra turn requested");
    }
    for (const delta of turn) {
      request.signal?.throwIfAborted();
      yield delta;
      await Promise.resolve();
    }
  }
}

export function textTurn(text: string, usage: Usage = zeroUsage): TurnDelta[] {
  return [
    { type: "text", text },
    { type: "done", usage },
  ];
}

export function toolCallTurn(call: ToolCallPart, usage: Usage = zeroUsage): TurnDelta[] {
  return [
    { type: "tool-call", call },
    { type: "done", usage },
  ];
}
