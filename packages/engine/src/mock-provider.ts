import type { ModelCapabilities } from "./capabilities.ts";
import type { ToolCallPart, Usage } from "./messages.ts";
import type { Provider, ProviderRequest, TurnDelta } from "./provider.ts";

const zeroUsage: Usage = { inputTokens: 0, outputTokens: 0 };

export interface MockProviderOptions {
  modelId?: string | undefined;
  capabilities?: ModelCapabilities | undefined;
}

export class MockProvider implements Provider {
  readonly name = "mock";
  readonly modelId: string | undefined;
  readonly capabilities: ModelCapabilities | undefined;
  private readonly script: TurnDelta[][];

  constructor(turns: TurnDelta[][], options: string | MockProviderOptions = {}) {
    this.script = [...turns];
    const resolved = typeof options === "string" ? { modelId: options } : options;
    this.modelId = resolved.modelId;
    this.capabilities = resolved.capabilities;
  }

  remaining(): number {
    return this.script.length;
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
