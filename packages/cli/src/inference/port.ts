import {
  declaredCapabilitiesFor,
  formatReference,
  formatTokenCount,
  type InferenceRegistry,
  type ProviderRegistration,
  protocols,
  type ResolutionFailure,
} from "@keywork/engine";
import type { InferencePort, ModelChoice, ResolutionNotice } from "@keywork/tui";
import type { ObservationMap } from "./observations.ts";

export interface InferencePortDeps {
  registry: () => InferenceRegistry;
  observations: () => ObservationMap;
}

export interface CommandVocabulary {
  connect: string;
  model: string;
}

export const slashCommands: CommandVocabulary = { connect: "/connect", model: "/model" };

export const shellCommands: CommandVocabulary = { connect: "keywork connect", model: "--model" };

export function inferencePort(deps: InferencePortDeps): InferencePort {
  return {
    choices: () => choicesOf(deps.registry(), deps.observations()),
    describe: (reference) => describeResolution(deps.registry(), reference),
  };
}

export function nextActionFor(
  failure: ResolutionFailure,
  commands: CommandVocabulary = slashCommands,
): string {
  switch (failure.code) {
    case "unconfigured":
      return failure.available.length === 0
        ? `run ${commands.connect}`
        : `pick one with ${commands.model}`;
    case "ambiguous":
      return failure.reference === ""
        ? `pick one with ${commands.model} or set "model" in keywork.json`
        : "qualify it as provider/model";
    case "unknown-provider":
      return `run ${commands.connect} ${failure.provider} to add it`;
    case "unknown-model":
      return failure.provider === undefined
        ? `use a provider-qualified reference like provider/model, or ${commands.connect} a provider`
        : `run ${commands.connect} ${failure.provider} to refresh its models, or pick one with ${commands.model}`;
    case "disabled-provider":
      return `enable it with ${commands.connect} ${failure.provider}`;
    case "unavailable-credential":
      return `run ${commands.connect} ${failure.provider}`;
    case "unsupported-protocol":
      return `set it to one of ${protocols.join(", ")}`;
    case "missing-capability":
      return `declare models["${failure.model}"].${failure.capability}: true once the model supports it`;
    case "insecure-endpoint":
      return `use an https:// endpoint, or set connections.${failure.provider}.insecureTransport after reading its risk note`;
  }
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
      ...windowFact(entry.registration, entry.spec.id),
    ],
  }));
  const defaults = registry.all().flatMap(unlistedDefaultChoice);
  return [...listed, ...defaults].sort(byAvailabilityThenName);
}

export function describeResolution(
  registry: InferenceRegistry,
  reference: string,
): ResolutionNotice {
  const resolution = registry.bind(reference);
  if (resolution.ok) {
    const window = resolution.binding.capabilities.contextWindow;
    const ctx = window === undefined ? "ctx assumed" : `ctx ${formatTokenCount(window)}`;
    return {
      ok: true,
      message: `${formatReference(resolution.binding.reference)} · ${resolution.binding.protocol} · ${ctx}`,
    };
  }
  return {
    ok: false,
    code: resolution.failure.code,
    message: resolution.failure.message,
    nextAction: nextActionFor(resolution.failure),
  };
}

export function declaredWindowOf(
  registration: ProviderRegistration,
  modelId: string,
): number | undefined {
  const listed = registration.models.find((spec) => spec.id === modelId)?.capabilities;
  if (listed?.contextWindow !== undefined) return listed.contextWindow;
  return declaredCapabilitiesFor(registration.capabilityDeclarations, modelId).contextWindow;
}

function unlistedDefaultChoice(registration: ProviderRegistration): ModelChoice[] {
  const model = registration.defaultModel;
  if (model === undefined || !registration.enabled) return [];
  if (registration.models.some((spec) => spec.id === model)) return [];
  return [
    {
      reference: formatReference({ provider: registration.name, model }),
      provider: registration.name,
      model,
      available: registration.credential.kind !== "missing",
      facts: [
        registration.protocol,
        credentialFact(registration),
        "provider default",
        ...windowFact(registration, model),
      ],
    },
  ];
}

function windowFact(registration: ProviderRegistration, modelId: string): string[] {
  const window = declaredWindowOf(registration, modelId);
  return window === undefined ? [] : [`ctx ${formatTokenCount(window)}`];
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
