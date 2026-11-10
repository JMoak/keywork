import { formatReference } from "@keywork/engine";
import { inferencePort } from "./inference/port.ts";
import type { InferenceState } from "./inference-state.ts";
import { updateUserConfig } from "./user-config.ts";

export interface FirstModelSetup {
  refresh(): Promise<void>;
  standing(): FirstModelStanding;
  choices(provider?: string): readonly string[];
  check(reference: string): string | undefined;
  remember(reference: string, previous: string | undefined): Promise<string | undefined>;
}

export type FirstModelStanding =
  | { kind: "available"; reference: string; configured: string | undefined }
  | { kind: "needs-model"; configured: string | undefined; reason: string };

interface SetupInference {
  current(): Pick<InferenceState, "config" | "observations" | "runtime">;
  reload(): Promise<void>;
}

export function firstModelSetupFor(inference: SetupInference, userDir?: string): FirstModelSetup {
  const catalog = inferencePort({
    registry: () => inference.current().runtime.registry,
    observations: () => inference.current().observations,
  });
  const check = (reference: string): string | undefined => {
    const result = inference.current().runtime.registry.bind(reference);
    if (!result.ok) return result.failure.message;
    return formatReference(result.binding.reference) === reference
      ? undefined
      : "Enter a model as provider/model.";
  };
  return {
    refresh: () => inference.reload(),
    standing: () => {
      const { runtime, config } = inference.current();
      const result = runtime.resolve({ default: config.model });
      return result.ok
        ? {
            kind: "available",
            reference: formatReference(result.binding.reference),
            configured: config.model,
          }
        : { kind: "needs-model", configured: config.model, reason: result.failure.message };
    },
    choices: (provider) =>
      catalog
        .choices()
        .filter(
          (model) => model.available && (provider === undefined || model.provider === provider),
        )
        .map((model) => model.reference),
    check,
    remember: async (reference, previous) => {
      await inference.reload();
      const problem = check(reference);
      if (problem !== undefined) return problem;
      let saved = false;
      await updateUserConfig((existing) => {
        if (existing.model !== previous) return existing;
        saved = true;
        return { ...existing, model: reference };
      }, userDir);
      if (!saved) return "The starting model changed while setup was open.";
      await inference.reload();
      return undefined;
    },
  };
}
