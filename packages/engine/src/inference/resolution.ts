import {
  declaredCapabilitiesFor,
  type ModelCapabilities,
  undeclaredCapabilities,
} from "../capabilities.ts";
import {
  endpointScheme,
  formatReference,
  isLoopbackEndpoint,
  parseReference,
} from "./references.ts";
import {
  httpProtocols,
  type InferenceBinding,
  type ModelReference,
  type ModelSpec,
  type Protocol,
  type ProviderRegistration,
  protocols,
  type Resolution,
  type ResolutionFailure,
  type ResolutionRequest,
} from "./types.ts";

export interface CatalogEntry {
  reference: ModelReference;
  registration: ProviderRegistration;
  spec: ModelSpec;
  available: boolean;
}

export function resolveModel(
  registrations: readonly ProviderRegistration[],
  request: ResolutionRequest,
): Resolution {
  const ranked = [request.override, request.selection, request.default].find(
    (candidate): candidate is string => candidate !== undefined && candidate !== "",
  );
  return ranked === undefined ? soleCandidate(registrations) : bindModel(registrations, ranked);
}

export function bindModel(
  registrations: readonly ProviderRegistration[],
  text: string,
): Resolution {
  const qualified = parseReference(text);
  if (
    qualified !== undefined &&
    registrationNamed(registrations, qualified.provider) !== undefined
  ) {
    return bindReference(registrations, qualified, text);
  }
  return bindBareName(registrations, text);
}

export function catalogOf(registrations: readonly ProviderRegistration[]): readonly CatalogEntry[] {
  return enabledOnly(registrations).flatMap((registration) =>
    registration.models.map((spec) => ({
      reference: { provider: registration.name, model: spec.id },
      registration,
      spec,
      available: isAvailable(registration),
    })),
  );
}

export function isAvailable(registration: ProviderRegistration): boolean {
  return registration.enabled && registration.credential.kind !== "missing";
}

function soleCandidate(registrations: readonly ProviderRegistration[]): Resolution {
  const available = registrations.filter(isAvailable);
  if (available.length === 0) {
    return fail({
      code: "unconfigured",
      available: [],
      message: "no inference provider is configured",
    });
  }
  const candidates = available.flatMap((registration) =>
    defaultCandidates(registration).map((model) => ({ provider: registration.name, model })),
  );
  const sole = candidates[0];
  if (candidates.length === 1 && sole !== undefined) {
    return bindReference(registrations, sole, formatReference(sole));
  }
  if (candidates.length === 0) {
    return fail({
      code: "unconfigured",
      available: available.map((registration) => registration.name),
      message: `${describeProviders(available)} configured but no default model chosen`,
    });
  }
  return fail({
    code: "ambiguous",
    reference: "",
    candidates: candidates.map(formatReference),
    message: `${candidates.length} models could be the default`,
  });
}

function bindBareName(registrations: readonly ProviderRegistration[], model: string): Resolution {
  const enabled = enabledOnly(registrations);
  const listing = enabled.filter((registration) => registration.models.some(matches(model)));
  const serving =
    listing.length > 0 ? listing : enabled.filter((registration) => registration.openCatalog);
  const [first] = serving;
  if (first === undefined) return unknownBareName(registrations, model);
  const available = serving.filter(isAvailable);
  if (available.length > 1) {
    return fail({
      code: "ambiguous",
      reference: model,
      candidates: available.map((registration) =>
        formatReference({ provider: registration.name, model }),
      ),
      message: `"${model}" is served by ${available.length} providers`,
    });
  }
  const chosen = available[0] ?? first;
  return bindReference(registrations, { provider: chosen.name, model }, model);
}

function unknownBareName(registrations: readonly ProviderRegistration[], text: string): Resolution {
  const qualified = parseReference(text);
  if (qualified !== undefined) return unknownProvider(registrations, text, qualified.provider);
  return fail({
    code: "unknown-model",
    reference: text,
    provider: undefined,
    known: catalogOf(registrations).map((entry) => formatReference(entry.reference)),
    message: `no configured provider knows a model named "${text}"`,
  });
}

function bindReference(
  registrations: readonly ProviderRegistration[],
  reference: ModelReference,
  asWritten: string,
): Resolution {
  const registration = registrationNamed(registrations, reference.provider);
  const text = formatReference(reference);
  if (registration === undefined) return unknownProvider(registrations, text, reference.provider);
  if (!registration.enabled) {
    return fail({
      code: "disabled-provider",
      reference: text,
      provider: registration.name,
      message: `provider "${registration.name}" is disabled`,
    });
  }
  if (registration.credential.kind === "missing") {
    return fail({
      code: "unavailable-credential",
      reference: text,
      provider: registration.name,
      expected: registration.credential.expected,
      message: `${registration.name} has no credential (${registration.credential.expected})${alternativeNote(registrations, asWritten, registration)}`,
    });
  }
  const spec = specFor(registration, reference.model);
  if (spec === undefined) {
    return fail({
      code: "unknown-model",
      reference: text,
      provider: registration.name,
      known: registration.models.map((listed) => listed.id),
      message: `${registration.name} does not list a model "${reference.model}"`,
    });
  }
  const protocol = spec.protocol ?? registration.protocol;
  if (!protocols.includes(protocol)) {
    return fail({
      code: "unsupported-protocol",
      reference: text,
      protocol,
      message: `${text} declares protocol "${protocol}", which keywork does not speak`,
    });
  }
  const transport = transportFailure(registration, text, protocol);
  if (transport !== undefined) return fail(transport);
  const capabilities = spec.capabilities ?? undeclaredCapabilities;
  if (!capabilities.toolCalls) {
    return fail({
      code: "missing-capability",
      reference: text,
      model: reference.model,
      capability: "toolCalls",
      message: `${text} is declared without tool-call support, and keywork drives everything through tools`,
    });
  }
  return { ok: true, binding: bindingOf(reference, registration, spec, protocol, capabilities) };
}

function unknownProvider(
  registrations: readonly ProviderRegistration[],
  reference: string,
  provider: string,
): Resolution {
  return fail({
    code: "unknown-provider",
    reference,
    provider,
    known: registrations.map((registration) => registration.name),
    message: `no provider named "${provider}"`,
  });
}

function alternativeNote(
  registrations: readonly ProviderRegistration[],
  asWritten: string,
  chosen: ProviderRegistration,
): string {
  const servers = registrations.filter(
    (registration) =>
      isAvailable(registration) &&
      registration.name !== chosen.name &&
      (registration.openCatalog || registration.models.some(matches(asWritten))),
  );
  if (servers.length === 0) return "";
  const suggestions = servers.map((registration) =>
    formatReference({ provider: registration.name, model: asWritten }),
  );
  return ` · did you mean ${suggestions.join(" or ")}?`;
}

function bindingOf(
  reference: ModelReference,
  registration: ProviderRegistration,
  spec: ModelSpec,
  protocol: Protocol,
  capabilities: ModelCapabilities,
): InferenceBinding {
  return {
    reference,
    registration,
    spec,
    protocol,
    capabilities,
    credential:
      registration.credential.kind === "present" ? registration.credential.handle : undefined,
  };
}

function fail(failure: ResolutionFailure): Resolution {
  return { ok: false, failure };
}

function registrationNamed(
  registrations: readonly ProviderRegistration[],
  name: string,
): ProviderRegistration | undefined {
  return registrations.find((registration) => registration.name === name);
}

function enabledOnly(registrations: readonly ProviderRegistration[]): ProviderRegistration[] {
  return registrations.filter((registration) => registration.enabled);
}

function matches(model: string): (spec: ModelSpec) => boolean {
  return (spec) => spec.id === model;
}

function specFor(registration: ProviderRegistration, model: string): ModelSpec | undefined {
  const listed = registration.models.find(matches(model));
  const spec =
    listed ?? (registration.openCatalog ? { id: model, origin: "unlisted" as const } : undefined);
  if (spec === undefined || spec.capabilities !== undefined) return spec;
  const declarations = registration.capabilityDeclarations;
  if (declarations === undefined) return spec;
  return { ...spec, capabilities: declaredCapabilitiesFor(declarations, model) };
}

function defaultCandidates(registration: ProviderRegistration): readonly string[] {
  const listed = registration.models.map((spec) => spec.id);
  if (registration.defaultModel !== undefined && !listed.includes(registration.defaultModel)) {
    return [...listed, registration.defaultModel];
  }
  return listed;
}

function describeProviders(registrations: readonly ProviderRegistration[]): string {
  const names = registrations.map((registration) => registration.name);
  return names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
}

function transportFailure(
  registration: ProviderRegistration,
  reference: string,
  protocol: Protocol,
): ResolutionFailure | undefined {
  if (!httpProtocols.has(protocol)) return undefined;
  const scheme = endpointScheme(registration.endpoint);
  if (scheme === "https") return undefined;
  if (
    scheme === "http" &&
    (isLoopbackEndpoint(registration.endpoint) || registration.insecureTransport)
  )
    return undefined;
  return {
    code: "insecure-endpoint",
    reference,
    provider: registration.name,
    endpoint: registration.endpoint,
    message: `${registration.name} points at ${registration.endpoint}, which is not HTTPS and not loopback`,
  };
}
