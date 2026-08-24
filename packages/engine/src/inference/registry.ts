import { endpointScheme } from "./references.ts";
import {
  bindModel,
  type CatalogEntry,
  catalogOf,
  isAvailable,
  resolveModel,
} from "./resolution.ts";
import {
  httpProtocols,
  InvalidRegistrationError,
  type ProviderRegistration,
  protocols,
  type Resolution,
  type ResolutionRequest,
} from "./types.ts";

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
    return catalogOf(this.all());
  }

  resolve(request: ResolutionRequest): Resolution {
    return resolveModel(this.all(), request);
  }

  bind(text: string): Resolution {
    return bindModel(this.all(), text);
  }
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
