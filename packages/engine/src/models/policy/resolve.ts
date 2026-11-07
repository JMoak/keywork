import { mostSpecificMatch } from "@keywork/shared";
import {
  declaredCapabilitiesFor,
  type ModelCapabilityDeclaration,
  undeclaredCapabilities,
} from "../../capabilities.ts";
import { endpointScheme, formatReference, isLoopbackEndpoint } from "../../inference/references.ts";
import { bindModel } from "../../inference/resolution.ts";
import type {
  InferenceBinding,
  ProviderRegistration,
  Resolution,
  ResolutionFailure,
} from "../../inference/types.ts";
import {
  blankRecord,
  type CapabilityRecord,
  decidesThroughBuiltin,
  known,
  type MissingCapability,
  measurementOf,
  missingFor,
  type ServerFingerprint,
  unknownCapability,
} from "../capabilities/index.ts";
import { hostedDecisionModel } from "../decide/detect.ts";
import { type Locality, localityOf } from "./locality.ts";
import {
  type ModelCandidate,
  type ModelClass,
  type PolicyLevel,
  type PolicyLevels,
  policyLevels,
} from "./types.ts";

export interface PolicyRequest {
  modelClass: ModelClass;
  levels: PolicyLevels;
  cloudFallback?: boolean | undefined;
}

export interface PolicyEnvironment {
  registrations: readonly ProviderRegistration[];
  capabilityOf?: ((binding: InferenceBinding) => CapabilityRecord | undefined) | undefined;
  refusalOf?:
    | ((binding: InferenceBinding, capabilities: CapabilityRecord) => ResolutionFailure | undefined)
    | undefined;
  now?: (() => Date) | undefined;
}

export interface PlannedCandidate {
  level: PolicyLevel;
  binding: InferenceBinding;
  locality: Locality;
  capabilities: CapabilityRecord;
  decider?: "builtin";
}

export type RefusedCandidate = UnresolvedCandidate | LocalOnlyCandidate;

export interface UnresolvedCandidate {
  level: PolicyLevel;
  candidate: ModelCandidate;
  reason: "unresolved";
  failure: ResolutionFailure;
}

export interface LocalOnlyCandidate {
  level: PolicyLevel;
  candidate: ModelCandidate;
  reason: "local-only";
}

export interface PolicyPlan {
  modelClass: ModelClass;
  candidates: readonly [PlannedCandidate, ...PlannedCandidate[]];
  refused: readonly RefusedCandidate[];
  localOnly: boolean;
}

export type PolicyResolution =
  | { ok: true; kind: "inherit"; modelClass: ModelClass }
  | { ok: true; kind: "plan"; plan: PolicyPlan }
  | {
      ok: false;
      level: PolicyLevel;
      failure: ResolutionFailure;
      refused: readonly RefusedCandidate[];
    };

export function resolvePolicy(
  request: PolicyRequest,
  environment: PolicyEnvironment,
): PolicyResolution {
  const chosen = chosenCandidates(request);
  if (chosen.length === 0) return { ok: true, kind: "inherit", modelClass: request.modelClass };
  const outcomes = chosen.map((choice) => planCandidate(choice, request.modelClass, environment));
  const planned = outcomes.filter(isPlanned);
  const unresolved = outcomes.filter(isUnresolved);
  const [primary, ...rest] = planned;
  const [nearest] = unresolved;
  if (primary === undefined) {
    if (nearest === undefined) throw new Error("every chosen candidate is planned or unresolved");
    return { ok: false, level: nearest.level, failure: nearest.failure, refused: unresolved };
  }
  const localOnly = primary.locality === "local";
  const keepsPrivacy = (candidate: PlannedCandidate): boolean =>
    !localOnly || request.cloudFallback === true || candidate.locality === "local";
  return {
    ok: true,
    kind: "plan",
    plan: {
      modelClass: request.modelClass,
      candidates: [primary, ...rest.filter(keepsPrivacy)],
      refused: [
        ...unresolved,
        ...rest.filter((candidate) => !keepsPrivacy(candidate)).map(refusedForPrivacy),
      ],
      localOnly,
    },
  };
}

export function bindForClass(
  candidate: ModelCandidate,
  modelClass: ModelClass,
  registrations: readonly ProviderRegistration[],
): Resolution {
  const registration = registrations.find(({ name }) => name === candidate.provider);
  if (registration === undefined) return unknownProvider(candidate, registrations);
  if (modelClass === "decide") return bindDecisionModel(registration, candidate);
  return bindModel(registrations, formatReference(candidate));
}

export function declaredFingerprint({
  registration,
  protocol,
}: Pick<InferenceBinding, "registration" | "protocol">): ServerFingerprint {
  return {
    id: `declared:${registration.name}`,
    kind: protocol === "anthropic-messages" ? "anthropic" : "openai-compatible",
    version: null,
    build: null,
    routes: [],
  };
}

interface Choice {
  level: PolicyLevel;
  candidate: ModelCandidate;
}

function chosenCandidates({ modelClass, levels }: PolicyRequest): Choice[] {
  const choices: Choice[] = [];
  for (const level of policyLevels) {
    const slot = levels[level]?.[modelClass];
    if (slot === undefined || slot === "inherit") continue;
    if (choices.some(({ candidate }) => sameCandidate(candidate, slot))) continue;
    choices.push({ level, candidate: slot });
  }
  return choices;
}

function planCandidate(
  { level, candidate }: Choice,
  modelClass: ModelClass,
  environment: PolicyEnvironment,
): PlannedCandidate | UnresolvedCandidate {
  const bound = bindForClass(candidate, modelClass, environment.registrations);
  if (!bound.ok) return { level, candidate, reason: "unresolved", failure: bound.failure };
  const { binding } = bound;
  const capabilities =
    environment.capabilityOf?.(binding) ??
    declaredRecord(
      binding.registration,
      binding.reference.model,
      (environment.now ?? (() => new Date()))().toISOString(),
    );
  const missing = missingFor(capabilities, modelClass);
  if (missing.length > 0) {
    const failure = missingCapability(binding, modelClass, missing, capabilities);
    return { level, candidate, reason: "unresolved", failure };
  }
  const refusal = environment.refusalOf?.(binding, capabilities);
  if (refusal !== undefined) return { level, candidate, reason: "unresolved", failure: refusal };
  return {
    level,
    binding,
    locality: localityOf(binding.registration.endpoint),
    capabilities,
    ...(modelClass === "decide" && decidesThroughBuiltin(capabilities) && { decider: "builtin" }),
  };
}

function bindDecisionModel(
  registration: ProviderRegistration,
  candidate: ModelCandidate,
): Resolution {
  const reference = formatReference(candidate);
  const refusal = registrationRefusal(registration, reference);
  if (refusal !== undefined) return { ok: false, failure: refusal };
  const listed = registration.models.find(({ id }) => id === candidate.model);
  return {
    ok: true,
    binding: {
      reference: candidate,
      registration,
      spec: listed ?? { id: candidate.model, origin: "unlisted" },
      protocol: listed?.protocol ?? registration.protocol,
      capabilities:
        listed?.capabilities ??
        declaredCapabilitiesFor(registration.capabilityDeclarations, candidate.model),
      credential:
        registration.credential.kind === "present" ? registration.credential.handle : undefined,
    },
  };
}

function registrationRefusal(
  registration: ProviderRegistration,
  reference: string,
): ResolutionFailure | undefined {
  const provider = registration.name;
  if (!registration.enabled) {
    return {
      code: "disabled-provider",
      reference,
      provider,
      message: `provider "${provider}" is disabled`,
    };
  }
  if (registration.credential.kind === "missing") {
    const { expected } = registration.credential;
    return {
      code: "unavailable-credential",
      reference,
      provider,
      expected,
      message: `${provider} has no credential (${expected})`,
    };
  }
  if (!transportIsPrivate(registration)) {
    return {
      code: "insecure-endpoint",
      reference,
      provider,
      endpoint: registration.endpoint,
      message: `${provider} points at ${registration.endpoint}, which is not HTTPS and not loopback`,
    };
  }
  return undefined;
}

function transportIsPrivate({ endpoint, insecureTransport }: ProviderRegistration): boolean {
  const scheme = endpointScheme(endpoint);
  if (scheme === "https") return true;
  return scheme === "http" && (isLoopbackEndpoint(endpoint) || insecureTransport === true);
}

export function declaredRecord(
  registration: ProviderRegistration,
  model: string,
  probedAt: string,
): CapabilityRecord {
  const declaration = declarationOf(registration, model);
  const declared = { source: "declared" } as const;
  const hosted = hostedDecisionModel(registration.endpoint, model);
  const listed = registration.models.find(({ id }) => id === model);
  const fingerprint = declaredFingerprint({
    registration,
    protocol: listed?.protocol ?? registration.protocol,
  });
  const record: CapabilityRecord = {
    ...blankRecord(registration.endpoint, model, fingerprint, probedAt),
    tools: known(declaration?.toolCalls ?? undeclaredCapabilities.toolCalls, declared),
    imageInput:
      declaration?.input === undefined
        ? unknownCapability("neither keywork.json nor the provider's catalogue names its input")
        : known(declaration.input.includes("image") ? "base64" : "none", declared),
    ...(declaration?.contextWindow !== undefined && {
      contextAllocated: known(declaration.contextWindow, declared),
    }),
  };
  if (hosted === undefined) return record;
  const decisionModel = { source: "server-delta", rule: hosted.label } as const;
  return {
    ...record,
    tools: known(false, decisionModel),
    imageInput: known("none", decisionModel),
    decisionEndpoint: known("/v1/systemone", decisionModel),
  };
}

function declarationOf(
  registration: ProviderRegistration,
  model: string,
): ModelCapabilityDeclaration | undefined {
  const listed = registration.models.find(({ id }) => id === model)?.capabilities;
  return listed ?? mostSpecificMatch(registration.capabilityDeclarations, model);
}

function missingCapability(
  binding: InferenceBinding,
  modelClass: ModelClass,
  missing: readonly MissingCapability[],
  capabilities: CapabilityRecord,
): ResolutionFailure {
  const reference = formatReference(binding.reference);
  const gaps = missing
    .map((gap) => `${measurementOf(capabilities, gap.capability)}, and it needs ${gap.needs}`)
    .join("; ");
  return {
    code: "missing-capability",
    reference,
    model: binding.reference.model,
    capability: missing[0]?.capability ?? "unknown",
    message: `${reference} cannot serve the ${modelClass} class: ${gaps}`,
  };
}

function unknownProvider(
  candidate: ModelCandidate,
  registrations: readonly ProviderRegistration[],
): Resolution {
  return {
    ok: false,
    failure: {
      code: "unknown-provider",
      reference: formatReference(candidate),
      provider: candidate.provider,
      known: registrations.map(({ name }) => name),
      message: `no provider named "${candidate.provider}"`,
    },
  };
}

function refusedForPrivacy({ level, binding }: PlannedCandidate): LocalOnlyCandidate {
  return { level, candidate: binding.reference, reason: "local-only" };
}

function isPlanned(outcome: PlannedCandidate | UnresolvedCandidate): outcome is PlannedCandidate {
  return "binding" in outcome;
}

function isUnresolved(
  outcome: PlannedCandidate | UnresolvedCandidate,
): outcome is UnresolvedCandidate {
  return !isPlanned(outcome);
}

function sameCandidate(left: ModelCandidate, right: ModelCandidate): boolean {
  return left.provider === right.provider && left.model === right.model;
}
