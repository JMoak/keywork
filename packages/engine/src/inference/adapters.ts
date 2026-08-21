import { withDeclaredCapabilities } from "../capabilities.ts";
import type { Provider } from "../provider.ts";
import { BedrockProvider } from "../providers/bedrock/bedrock.ts";
import type { AwsCredentials } from "../providers/bedrock/sigv4.ts";
import { type FetchLike, OpenAiCompatibleProvider } from "../providers/openai.ts";
import { OpenAiResponsesProvider } from "../providers/openai-responses.ts";
import { RetryingProvider } from "../providers/retry.ts";
import { formatReference } from "./references.ts";
import type { CredentialHandle, InferenceBinding, ModelReference } from "./types.ts";

export type CredentialMaterial =
  | { kind: "api-key"; key: string }
  | { kind: "bearer"; headers: () => Promise<Record<string, string>> }
  | { kind: "aws-sigv4"; credentials: AwsCredentials };

export interface CredentialVault {
  material(handle: CredentialHandle): CredentialMaterial | undefined;
}

export interface AdapterOptions {
  vault: CredentialVault;
  fetchFn?: FetchLike | undefined;
}

export class CredentialMaterialError extends Error {
  constructor(
    readonly reference: ModelReference,
    message: string,
  ) {
    super(`${formatReference(reference)}: ${message}`);
    this.name = "CredentialMaterialError";
  }
}

export function providerFor(binding: InferenceBinding, options: AdapterOptions): Provider {
  const material = materialFor(binding, options.vault);
  const transport = transportFor(binding, material, options.fetchFn);
  return withDeclaredCapabilities(new RetryingProvider(transport), binding.capabilities);
}

export function modelReferenceOf(provider: Provider): string | undefined {
  return provider.modelId === undefined ? undefined : `${provider.name}/${provider.modelId}`;
}

function materialFor(
  binding: InferenceBinding,
  vault: CredentialVault,
): CredentialMaterial | undefined {
  if (binding.credential === undefined) return undefined;
  const material = vault.material(binding.credential);
  if (material === undefined) {
    throw new CredentialMaterialError(
      binding.reference,
      `credential "${binding.credential.label}" is no longer available`,
    );
  }
  return material;
}

function transportFor(
  binding: InferenceBinding,
  material: CredentialMaterial | undefined,
  fetchFn: FetchLike | undefined,
): Provider {
  const { registration, reference } = binding;
  const headers = registration.decorations?.headers;
  const body = registration.decorations?.body;
  switch (binding.protocol) {
    case "chat-completions":
      return new OpenAiCompatibleProvider({
        name: registration.name,
        baseUrl: registration.endpoint,
        model: reference.model,
        authHeaders: httpAuthHeaders(binding, material),
        ...(headers !== undefined && { extraHeaders: headers }),
        ...(body !== undefined && { extraBody: body }),
        ...(fetchFn !== undefined && { fetchFn }),
      });
    case "responses":
      return new OpenAiResponsesProvider({
        name: registration.name,
        baseUrl: registration.endpoint,
        model: reference.model,
        authHeaders: httpAuthHeaders(binding, material),
        ...(headers !== undefined && { extraHeaders: headers }),
        ...(fetchFn !== undefined && { fetchFn }),
      });
    case "bedrock-converse":
      return new BedrockProvider({
        region: registration.endpoint,
        model: reference.model,
        credentials: awsCredentials(binding, material),
        ...(fetchFn !== undefined && { fetchFn }),
      });
  }
}

function httpAuthHeaders(
  binding: InferenceBinding,
  material: CredentialMaterial | undefined,
): () => Promise<Record<string, string>> {
  if (material === undefined) return async () => ({});
  switch (material.kind) {
    case "api-key":
      return async () => ({ authorization: `Bearer ${material.key}` });
    case "bearer":
      return material.headers;
    case "aws-sigv4":
      throw new CredentialMaterialError(
        binding.reference,
        `${binding.protocol} cannot authenticate with AWS SigV4 credentials`,
      );
  }
}

function awsCredentials(
  binding: InferenceBinding,
  material: CredentialMaterial | undefined,
): AwsCredentials {
  if (material?.kind !== "aws-sigv4") {
    throw new CredentialMaterialError(
      binding.reference,
      "bedrock-converse needs AWS SigV4 credentials",
    );
  }
  return material.credentials;
}
