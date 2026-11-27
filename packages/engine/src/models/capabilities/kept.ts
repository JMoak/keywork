import { join } from "node:path";
import { jsonFileStore, toError } from "@keywork/shared";
import type { CapabilityCache, CapabilityLearning } from "./cache.ts";

export interface KeptCapabilities {
  flush(): void;
  close(): void;
}

export function capabilityLearningFileIn(workspaceState: string): string {
  return join(workspaceState, "models", "learned.json");
}

export function keepCapabilities(
  cache: CapabilityCache,
  file: string,
  notice: (line: string) => void = () => undefined,
): KeptCapabilities {
  const store = jsonFileStore<CapabilityLearning | undefined>({
    file,
    mode: "lenient",
    validate: learningOf,
  });
  const saved = store.read();
  if (saved !== undefined) cache.absorb(saved);
  let pending: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
    try {
      store.write(cache.learning());
    } catch (cause) {
      notice(`what was learned about model servers was not saved: ${toError(cause).message}`);
    }
  };
  const unlisten = cache.onLearned(() => {
    if (pending !== undefined) return;
    pending = setTimeout(flush, saveAfterMs);
    pending.unref?.();
  });
  return {
    flush,
    close: () => {
      unlisten();
      if (pending !== undefined) flush();
    },
  };
}

const saveAfterMs = 250;

function learningOf(data: unknown): CapabilityLearning | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { learned, rejections } = data as Partial<CapabilityLearning>;
  if (!isRecord(learned) || !isRecord(rejections)) return undefined;
  return { learned, rejections } as CapabilityLearning;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
