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
  type InferenceBinding,
  InvalidRegistrationError,
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

export class InferenceRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>();

  register(registration: ProviderRegistration): void {
    validateRegistration(registration);
    this.registrations.set(registration.name, registration);
  }

  registration(name: string): ProviderRegistration | undefined {
    return this.registrations.get(name);
  }

  all(): readonly ProviderRegistration[] {
    return [...this.registrations.values()];
  }

  available(): readonly ProviderRegistration[] {
    return this.all().filter(isAvailable);
  }

  catalog(): readonly CatalogEntry[] {
    return this.all()
      .filter((registration) => registration.enabled)
      .flatMap((registration) =>
        listedSpecs(registration).map((spec) => ({
          reference: { provider: registration.name, model: spec.id },
          registration,
          spec,
          available: isAvailable(registration),
        })),
      );
  }

  resolve(request: ResolutionRequest): Resolution {
    const ranked = [request.override, request.selection, request.default].find(
      (candidate): candidate is string => candidate !== undefined && candidate !== "",
    );
    if (ranked !== undefined) return this.bind(ranked);
    return this.soleCandidate();
  }

  bind(text: string): Resolution {
    const qualified = parseReference(text);
    if (qualified !== undefined && this.registrations.has(qualified.provider)) {
      return this.bindReference(qualified, text);
    }
    return this.bindBareName(text);
  }

  private soleCandidate(): Resolution {
    const available = this.available();
    if (available.length === 0) {
      return fail({
        code: "unconfigured",
        message: "no inference provider is configured",
        nextAction: "run /connect to add one",
      });
    }
    const candidates = available.flatMap((registration) =>
      defaultCandidates(registration).map((model) => ({ provider: registration.name, model })),
    );
    const sole = candidates[0];
    if (candidates.length === 1 && sole !== undefined) {
      return this.bindReference(sole, formatReference(sole));
    }
    if (candidates.length === 0) {
      return fail({
        code: "unconfigured",
        message: `${describeProviders(available)} configured but no default model chosen`,
        nextAction: "pick one with /model",
      });
    }
    return fail({
      code: "ambiguous",
      reference: "",
      candidates: candidates.map(formatReference),
      message: `${candidates.length} models could be the default`,
      nextAction: `pick one with /model or set "model" in keywork.json`,
    });
  }

  private bindBareName(model: string): Resolution {
    const enabled = this.all().filter((registration) => registration.enabled);
    const listed = enabled.filter((registration) => listedSpecs(registration).some(matches(model)));
    const open = enabled.filter((registration) => registration.openCatalog);
    const matched = listed.length > 0 ? listed : open;
    if (matched.length === 0) return this.unknownBareName(model);
    const available = matched.filter(isAvailable);
    const first = matched[0] as ProviderRegistration;
    if (available.length === 0) return this.bindReference({ provider: first.name, model }, model);
    if (available.length === 1) {
      const only = available[0] as ProviderRegistration;
      return this.bindReference({ provider: only.name, model }, model);
    }
    return fail({
      code: "ambiguous",
      reference: model,
      candidates: available.map((registration) => `${registration.name}/${model}`),
      message: `"${model}" is served by ${available.length} providers`,
      nextAction: "qualify it as provider/model",
    });
  }

  private unknownBareName(text: string): Resolution {
    const qualified = parseReference(text);
    if (qualified !== undefined) {
      return fail({
        code: "unknown-provider",
        reference: text,
        provider: qualified.provider,
        known: [...this.registrations.keys()],
        message: `no provider named "${qualified.provider}"`,
        nextAction: `run /connect ${qualified.provider} to add it`,
      });
    }
    return fail({
      code: "unknown-model",
      reference: text,
      provider: undefined,
      known: this.catalog().map((entry) => formatReference(entry.reference)),
      message: `no configured provider knows a model named "${text}"`,
      nextAction: "use a provider-qualified reference like provider/model, or /connect a provider",
    });
  }

  private bindReference(reference: ModelReference, asWritten: string): Resolution {
    const registration = this.registrations.get(reference.provider);
    const text = formatReference(reference);
    if (registration === undefined) {
      return fail({
        code: "unknown-provider",
        reference: text,
        provider: reference.provider,
        known: [...this.registrations.keys()],
        message: `no provider named "${reference.provider}"`,
        nextAction: `run /connect ${reference.provider} to add it`,
      });
    }
    if (!registration.enabled) {
      return fail({
        code: "disabled-provider",
        reference: text,
        provider: registration.name,
        message: `provider "${registration.name}" is disabled`,
        nextAction: `enable it with /connect ${registration.name}`,
      });
    }
    if (registration.credential.kind === "missing") {
      return fail({
        code: "unavailable-credential",
        reference: text,
        provider: registration.name,
        expected: registration.credential.expected,
        message: `${registration.name} has no credential (${registration.credential.expected})${this.alternativeNote(asWritten, registration)}`,
        nextAction: `run /connect ${registration.name}`,
      });
    }
    const spec = specFor(registration, reference.model);
    if (spec === undefined) {
      return fail({
        code: "unknown-model",
        reference: text,
        provider: registration.name,
        known: listedSpecs(registration).map((listed) => listed.id),
        message: `${registration.name} does not list a model "${reference.model}"`,
        nextAction: `run /connect ${registration.name} to refresh its models, or pick one with /model`,
      });
    }
    const protocol = spec.protocol ?? registration.protocol;
    if (!protocols.includes(protocol)) {
      return fail({
        code: "unsupported-protocol",
        reference: text,
        protocol,
        message: `${text} declares protocol "${protocol}", which keywork does not speak`,
        nextAction: `set it to one of ${protocols.join(", ")}`,
      });
    }
    const transport = transportFailure(registration, text, protocol);
    if (transport !== undefined) return fail(transport);
    const capabilities = spec.capabilities ?? undeclaredCapabilities;
    if (!capabilities.toolCalls) {
      return fail({
        code: "missing-capability",
        reference: text,
        capability: "toolCalls",
        message: `${text} is declared without tool-call support, and keywork drives everything through tools`,
        nextAction: `declare models["${reference.model}"].toolCalls: true once the model supports it`,
      });
    }
    return {
      ok: true,
      binding: Object.freeze(bindingOf(reference, registration, spec, protocol, capabilities)),
    };
  }

  private alternativeNote(asWritten: string, chosen: ProviderRegistration): string {
    const servers = this.available().filter(
      (registration) =>
        registration.name !== chosen.name &&
        (registration.openCatalog || listedSpecs(registration).some(matches(asWritten))),
    );
    if (servers.length === 0) return "";
    return ` · did you mean ${servers.map((registration) => `${registration.name}/${asWritten}`).join(" or ")}?`;
  }
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

function isAvailable(registration: ProviderRegistration): boolean {
  return registration.enabled && registration.credential.kind !== "missing";
}

function listedSpecs(registration: ProviderRegistration): readonly ModelSpec[] {
  return registration.models;
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

const httpProtocols: ReadonlySet<Protocol> = new Set(["chat-completions", "responses"]);

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
    endpoint: registration.endpoint,
    message: `${registration.name} points at ${registration.endpoint}, which is not HTTPS and not loopback`,
    nextAction: `use an https:// endpoint, or set connections.${registration.name}.insecureTransport after reading its risk note`,
  };
}

function validateRegistration(registration: ProviderRegistration): void {
  if (registration.name === "" || registration.name.includes("/")) {
    throw new InvalidRegistrationError(
      registration.name,
      'name must be non-empty and contain no "/"',
    );
  }
  if (!protocols.includes(registration.protocol)) {
    throw new InvalidRegistrationError(
      registration.name,
      `unknown protocol "${registration.protocol}"`,
    );
  }
  if (
    httpProtocols.has(registration.protocol) &&
    endpointScheme(registration.endpoint) === undefined
  ) {
    throw new InvalidRegistrationError(
      registration.name,
      `endpoint "${registration.endpoint}" must be an http(s) URL for ${registration.protocol}`,
    );
  }
  if (
    registration.protocol === "bedrock-converse" &&
    registration.endpoint === "" &&
    registration.credential.kind !== "missing"
  ) {
    throw new InvalidRegistrationError(
      registration.name,
      "bedrock-converse needs a region as its endpoint",
    );
  }
}
