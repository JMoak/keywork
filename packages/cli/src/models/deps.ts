import {
  bindForClass,
  type Decider,
  declaredFingerprint,
  formatReference,
  type InferenceBinding,
  type Provider,
  type ProviderRegistration,
  parseReference,
  type Resolution,
  type ResolutionRequest,
  type ServerFingerprint,
} from "@keywork/engine";
import type { BenchOpening, ModelsCommandDeps } from "./command.ts";

export interface BenchRuntime {
  registrations(): readonly ProviderRegistration[];
  resolve(request: ResolutionRequest): Resolution;
  provider(binding: InferenceBinding): Provider;
  decider(binding: InferenceBinding): Decider;
  fingerprintOf?: ((binding: InferenceBinding) => ServerFingerprint | undefined) | undefined;
}

export function benchDepsFrom(
  runtime: BenchRuntime,
): Pick<ModelsCommandDeps, "openChat" | "openDecider"> {
  const opening = <Subject>(binding: InferenceBinding, open: () => Subject) =>
    openedOrRefused(
      binding,
      runtime.fingerprintOf?.(binding) ?? declaredFingerprint(binding),
      open,
    );
  return {
    openChat: (reference) => {
      const resolution = runtime.resolve({ selection: reference });
      if (!resolution.ok) return { ok: false, reason: resolution.failure.message };
      return opening(resolution.binding, () => runtime.provider(resolution.binding));
    },
    openDecider: (reference) => {
      const candidate = parseReference(reference);
      if (candidate === undefined) {
        return { ok: false, reason: `name a decision model as provider/model, not "${reference}"` };
      }
      const bound = bindForClass(candidate, "decide", runtime.registrations());
      if (!bound.ok) return { ok: false, reason: bound.failure.message };
      return opening(bound.binding, () => runtime.decider(bound.binding));
    },
  };
}

function openedOrRefused<Subject>(
  binding: InferenceBinding,
  fingerprint: ServerFingerprint,
  open: () => Subject,
): BenchOpening<Subject> {
  try {
    const subject = open();
    return { ok: true, reference: formatReference(binding.reference), fingerprint, subject };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
