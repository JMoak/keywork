import { MockProvider } from "../mock-provider.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";

export interface RecordingProvider extends Provider {
  readonly requests: ProviderRequest[];
}

export function recordingProvider(
  script?: TurnDelta[][],
  identity: { name?: string; modelId?: string } = {},
): RecordingProvider {
  const inner = script === undefined ? undefined : new MockProvider(script);
  const requests: ProviderRequest[] = [];
  return {
    name: identity.name ?? "recording",
    ...(identity.modelId !== undefined && { modelId: identity.modelId }),
    requests,
    stream: (request: ProviderRequest) => {
      requests.push(request);
      return inner === undefined ? okTurn() : inner.stream(request);
    },
  };
}

async function* okTurn(): AsyncIterable<TurnDelta> {
  yield { type: "text", text: "ok" };
  yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
}
