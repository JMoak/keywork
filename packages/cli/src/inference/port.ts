import {
  formatReference,
  type InferenceRegistry,
  type ProviderRegistration,
} from "@keywork/engine";
import type { InferencePort, ModelChoice, ResolutionNotice } from "@keywork/tui";
import type { ObservationMap } from "./observations.ts";

export interface InferencePortDeps {
  registry: () => InferenceRegistry;
  observations: () => ObservationMap;
}

export function inferencePort(deps: InferencePortDeps): InferencePort {
  return {
    choices: () => choicesOf(deps.registry(), deps.observations()),
    describe: (reference) => describeResolution(deps.registry(), reference),
  };
}

export function choicesOf(
  registry: InferenceRegistry,
  observations: ObservationMap,
): ModelChoice[] {
  const listed = registry.catalog().map((entry) => ({
    reference: formatReference(entry.reference),
    provider: entry.registration.name,
    model: entry.spec.id,
    available: entry.available,
    facts: [
      entry.spec.protocol ?? entry.registration.protocol,
      credentialFact(entry.registration),
      ...originFact(entry.spec.origin, observations[entry.registration.name]?.modelsReportedAt),
    ],
  }));
  const defaults = registry
    .all()
    .filter((registration) => registration.enabled && registration.defaultModel !== undefined)
    .filter(
      (registration) => !registration.models.some((spec) => spec.id === registration.defaultModel),
    )
    .map((registration) => ({
      reference: `${registration.name}/${registration.defaultModel}`,
      provider: registration.name,
      model: registration.defaultModel as string,
      available: registration.credential.kind !== "missing",
      facts: [registration.protocol, credentialFact(registration), "provider default"],
    }));
  return [...listed, ...defaults].sort(byAvailabilityThenName);
}

export function describeResolution(
  registry: InferenceRegistry,
  reference: string,
): ResolutionNotice {
  const resolution = registry.bind(reference);
  if (resolution.ok) {
    return {
      ok: true,
      message: `${formatReference(resolution.binding.reference)} · ${resolution.binding.protocol}`,
    };
  }
  return {
    ok: false,
    code: resolution.failure.code,
    message: resolution.failure.message,
    nextAction: resolution.failure.nextAction,
  };
}

function credentialFact(registration: ProviderRegistration): string {
  switch (registration.credential.kind) {
    case "none":
      return "no credential";
    case "present":
      return registration.credential.handle.label;
    case "missing":
      return `needs ${registration.credential.expected}`;
  }
}

function originFact(origin: string, reportedAt: string | undefined): string[] {
  if (origin === "reported")
    return [`reported ${reportedAt === undefined ? "" : reportedAt.slice(0, 10)}`.trim()];
  if (origin === "declared") return ["declared"];
  return [];
}

function byAvailabilityThenName(left: ModelChoice, right: ModelChoice): number {
  if (left.available !== right.available) return left.available ? -1 : 1;
  return left.reference.localeCompare(right.reference);
}
