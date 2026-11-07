import {
  type AdapterOptions,
  type CredentialMaterial,
  CredentialMaterialError,
} from "../../inference/adapters.ts";
import type { InferenceBinding } from "../../inference/types.ts";
import { type AuthHeaders, bearerHeaders } from "../../providers/transport.ts";
import { jevViaOpenRouter } from "./adapters/jev.ts";
import { systemOneDecider } from "./adapters/systemone.ts";
import { hostedDecisionModel } from "./detect.ts";
import type { Decider } from "./types.ts";

export function deciderFor(binding: InferenceBinding, options: AdapterOptions): Decider {
  const { registration, reference } = binding;
  const authHeaders = decisionAuthHeaders(binding, options);
  const fetchFn = options.fetchFn;
  if (hostedDecisionModel(registration.endpoint, reference.model)?.host === "openrouter.ai") {
    return jevViaOpenRouter({
      authHeaders,
      model: reference.model,
      provider: registration.name,
      endpoint: registration.endpoint,
      fetchFn,
    });
  }
  return systemOneDecider({ reference, endpoint: registration.endpoint, authHeaders, fetchFn });
}

function decisionAuthHeaders(binding: InferenceBinding, options: AdapterOptions): AuthHeaders {
  if (binding.credential === undefined) return bearerHeaders(undefined);
  const material = options.vault.material(binding.credential);
  if (material === undefined) {
    throw new CredentialMaterialError(
      binding.reference,
      `credential "${binding.credential.label}" is no longer available`,
    );
  }
  return headersFor(binding, material);
}

function headersFor(binding: InferenceBinding, material: CredentialMaterial): AuthHeaders {
  switch (material.kind) {
    case "api-key":
      return bearerHeaders(material.key);
    case "bearer":
      return material.headers;
    case "aws-sigv4":
      throw new CredentialMaterialError(
        binding.reference,
        "decision endpoints cannot authenticate with AWS SigV4 credentials",
      );
  }
}
