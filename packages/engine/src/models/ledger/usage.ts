import type { Usage } from "../../messages.ts";
import { totalCacheWrite } from "./normalize.ts";
import type { NormalizedUsage } from "./types.ts";

export function toKeyworkUsage(usage: NormalizedUsage | null): Usage {
  if (usage === null) return { inputTokens: 0, outputTokens: 0 };
  const written = totalCacheWrite(usage);
  return {
    inputTokens: usage.inputUncached,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 && { cacheReadInputTokens: usage.cacheRead }),
    ...(written > 0 && { cacheCreationInputTokens: written }),
    ...(usage.costSource === "provider" && usage.cost !== null && { costUsd: usage.cost }),
  };
}
