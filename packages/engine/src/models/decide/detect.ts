import { z } from "zod";

export interface HostedDecisionModel {
  host: string;
  model: string;
  label: string;
}

export const hostedDecisionModels: readonly HostedDecisionModel[] = [
  { host: "openrouter.ai", model: "typesafe/jev-1.14", label: "Jev 1.14 via OpenRouter" },
  { host: "openrouter.ai", model: "typesafe/jev-1.13", label: "Jev 1.13 via OpenRouter" },
  { host: "api.typesafe.ai", model: "jev-1.13.0", label: "Jev 1.13 via TypeSafe" },
];

export function hostedDecisionModel(
  endpoint: string,
  model: string,
): HostedDecisionModel | undefined {
  const host = hostOf(endpoint);
  return hostedDecisionModels.find((known) => known.host === host && known.model === model);
}

export function nativeDecisionModel(entry: unknown): boolean {
  return (
    llamaServerSaysDecisions(entry) || lmStudioSaysDecision(entry) || ollamaSaysDecision(entry)
  );
}

const llamaServerModel = z.object({
  architecture: z.object({ output_modalities: z.array(z.string()) }),
});

const lmStudioModel = z.object({ type: z.string() });

const ollamaShow = z.object({ capabilities: z.array(z.string()) });

function llamaServerSaysDecisions(entry: unknown): boolean {
  const parsed = llamaServerModel.safeParse(entry);
  return parsed.success && parsed.data.architecture.output_modalities.includes("decisions");
}

function lmStudioSaysDecision(entry: unknown): boolean {
  const parsed = lmStudioModel.safeParse(entry);
  return parsed.success && parsed.data.type === "decision";
}

function ollamaSaysDecision(entry: unknown): boolean {
  const parsed = ollamaShow.safeParse(entry);
  return parsed.success && parsed.data.capabilities.includes("decision");
}

function hostOf(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
