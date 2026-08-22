import type {
  Provider,
  ProviderRequest,
  Tool,
  TurnDelta,
} from "../../packages/engine/src/index.ts";

export const noteTool: Tool = {
  name: "note",
  description: "records a short note during the soak",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  execute: async (args) => `noted: ${(args as { text?: string }).text ?? ""}`,
};

export function replyMarker(turn: number): string {
  return `reply #${turn}`;
}

export class SoakProvider implements Provider {
  readonly name = "soak";
  readonly modelId = "soak-model";
  private turn = 0;
  private toolCallPending = false;

  constructor(private readonly toolEvery: number) {}

  turnsServed(): number {
    return this.turn;
  }

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    request.signal?.throwIfAborted();
    if (this.toolCallPending) {
      this.toolCallPending = false;
      yield* this.reply();
      return;
    }
    this.turn += 1;
    if (this.toolEvery > 0 && this.turn % this.toolEvery === 0) {
      this.toolCallPending = true;
      yield {
        type: "tool-call",
        call: {
          type: "tool-call",
          callId: `soak-${this.turn}`,
          name: noteTool.name,
          arguments: { text: `turn ${this.turn}` },
        },
      };
      yield { type: "done", usage: { inputTokens: 40, outputTokens: 12 } };
      return;
    }
    yield* this.reply();
  }

  private *reply(): Iterable<TurnDelta> {
    yield { type: "text", text: `${replyMarker(this.turn)} ` };
    yield { type: "text", text: "landed; the pane keeps its rhythm." };
    yield { type: "done", usage: { inputTokens: 40, outputTokens: 12 } };
  }
}
