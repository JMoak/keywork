import type { ModelCapabilities, ModelCapabilityDeclaration } from "../capabilities.ts";

export type Protocol = "chat-completions" | "responses" | "bedrock-converse";

export const protocols: readonly Protocol[] = ["chat-completions", "responses", "bedrock-converse"];

export interface ModelReference {
  provider: string;
  model: string;
}

export interface CredentialHandle {
  id: string;
  label: string;
}

export type CredentialState =
  | { kind: "none" }
  | { kind: "present"; handle: CredentialHandle }
  | { kind: "missing"; expected: string };

export type ModelOrigin = "declared" | "reported" | "unlisted";

export interface ModelSpec {
  id: string;
  origin: ModelOrigin;
  protocol?: Protocol | undefined;
  capabilities?: ModelCapabilities | undefined;
  label?: string | undefined;
}

export interface RequestDecorations {
  headers?: Readonly<Record<string, string>> | undefined;
  body?: Readonly<Record<string, unknown>> | undefined;
}

export interface ProviderRegistration {
  name: string;
  protocol: Protocol;
  endpoint: string;
  credential: CredentialState;
  models: readonly ModelSpec[];
  openCatalog: boolean;
  enabled: boolean;
  label?: string | undefined;
  defaultModel?: string | undefined;
  insecureTransport?: boolean | undefined;
  decorations?: RequestDecorations | undefined;
  capabilityDeclarations?: Readonly<Record<string, ModelCapabilityDeclaration>> | undefined;
}

export interface InferenceBinding {
  reference: ModelReference;
  registration: ProviderRegistration;
  spec: ModelSpec;
  protocol: Protocol;
  capabilities: ModelCapabilities;
  credential: CredentialHandle | undefined;
}

export interface ResolutionRequest {
  override?: string | undefined;
  selection?: string | undefined;
  default?: string | undefined;
}

interface FailureBase {
  message: string;
  nextAction: string;
}

export type ResolutionFailure = FailureBase &
  (
    | { code: "unconfigured" }
    | { code: "ambiguous"; reference: string; candidates: readonly string[] }
    | { code: "unknown-provider"; reference: string; provider: string; known: readonly string[] }
    | {
        code: "unknown-model";
        reference: string;
        provider: string | undefined;
        known: readonly string[];
      }
    | { code: "disabled-provider"; reference: string; provider: string }
    | { code: "unavailable-credential"; reference: string; provider: string; expected: string }
    | { code: "unsupported-protocol"; reference: string; protocol: string }
    | { code: "missing-capability"; reference: string; capability: string }
    | { code: "insecure-endpoint"; reference: string; endpoint: string }
  );

export type ResolutionFailureCode = ResolutionFailure["code"];

export type Resolution =
  | { ok: true; binding: InferenceBinding }
  | { ok: false; failure: ResolutionFailure };

export class ResolutionError extends Error {
  constructor(readonly failure: ResolutionFailure) {
    super(`${failure.message} · ${failure.nextAction}`);
    this.name = "ResolutionError";
  }
}

export class InvalidRegistrationError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`provider "${provider}": ${message}`);
    this.name = "InvalidRegistrationError";
  }
}
