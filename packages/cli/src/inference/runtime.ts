import {
  type CredentialHandle,
  type CredentialMaterial,
  type CredentialState,
  type CredentialVault,
  credentialsFromEnv,
  type FetchLike,
  formatReference,
  type InferenceBinding,
  InferenceRegistry,
  isLoopbackEndpoint,
  type ModelSpec,
  type Provider,
  type ProviderRegistration,
  providerFor,
  type Resolution,
  ResolutionError,
  type ResolutionRequest,
  regionFromEnv,
} from "@keywork/engine";
import type { ConnectionConfig, KeyworkConfig } from "@keywork/shared";
import type { Credential, CredentialMap, OauthCredential } from "../auth-store.ts";
import { codexAuthHeaders, freshAccessToken } from "../codex-login.ts";
import {
  type BuiltInProvider,
  builtInNames,
  builtInProviders,
  codexProviderName,
} from "./builtins.ts";
import type { ObservationMap } from "./observations.ts";

export type PersistCredential = (provider: string, credential: Credential) => Promise<void>;

export interface InferenceInputs {
  env: Record<string, string | undefined>;
  config: KeyworkConfig;
  credentials: CredentialMap;
  observations?: ObservationMap | undefined;
  persistCredential?: PersistCredential | undefined;
  fetchFn?: FetchLike | undefined;
}

export interface BoundProvider {
  binding: InferenceBinding;
  provider: Provider;
  reference: string;
}

export interface InferenceRuntime {
  registry: InferenceRegistry;
  warnings: readonly string[];
  resolve(request: ResolutionRequest): Resolution;
  open(request: ResolutionRequest): BoundProvider;
  provider(binding: InferenceBinding): Provider;
}

export function composeInference(inputs: InferenceInputs): InferenceRuntime {
  const materials = new Map<string, CredentialMaterial>();
  const vault: CredentialVault = { material: (handle) => materials.get(handle.id) };
  const registry = new InferenceRegistry();
  const warnings: string[] = [];
  for (const builtIn of builtInProviders) {
    registry.register(builtInRegistration(builtIn, inputs, materials));
  }
  for (const [name, connection] of Object.entries(inputs.config.connections ?? {})) {
    if (builtInNames.has(name)) {
      warnings.push(`connections.${name} is ignored: that name belongs to a built-in provider`);
      continue;
    }
    registry.register(connectionRegistration(name, connection, inputs, materials));
  }
  const provider = (binding: InferenceBinding): Provider =>
    providerFor(binding, {
      vault,
      ...(inputs.fetchFn !== undefined && { fetchFn: inputs.fetchFn }),
    });
  return {
    registry,
    warnings,
    resolve: (request) => registry.resolve(request),
    provider,
    open: (request) => {
      const resolution = registry.resolve(request);
      if (!resolution.ok) throw new ResolutionError(resolution.failure);
      return {
        binding: resolution.binding,
        provider: provider(resolution.binding),
        reference: formatReference(resolution.binding.reference),
      };
    },
  };
}

export const connectHint = `No inference provider yet. Pick one:
  keywork connect                       (interactive: local server, API key, or ChatGPT sign-in)
  KEYWORK_OPENROUTER_API_KEY=…  or  KEYWORK_OPENAI_API_KEY=…   (environment)
Inside keywork: /connect adds a provider, /model picks the model for a session.`;

function builtInRegistration(
  builtIn: BuiltInProvider,
  inputs: InferenceInputs,
  materials: Map<string, CredentialMaterial>,
): ProviderRegistration {
  const credential = builtInCredential(builtIn, inputs, materials);
  return {
    name: builtIn.name,
    label: builtIn.label,
    protocol: builtIn.protocol,
    endpoint: builtIn.protocol === "bedrock-converse" ? bedrockRegion(inputs) : builtIn.endpoint,
    credential,
    models: reportedModels(builtIn.name, inputs.observations),
    openCatalog: true,
    enabled: true,
    defaultModel: builtIn.defaultModel,
    decorations: builtIn.decorations,
    capabilityDeclarations: inputs.config.models,
  };
}

function builtInCredential(
  builtIn: BuiltInProvider,
  inputs: InferenceInputs,
  materials: Map<string, CredentialMaterial>,
): CredentialState {
  const { auth } = builtIn;
  switch (auth.kind) {
    case "api-key":
      return (
        apiKeyFromEnv(builtIn.name, auth.scopedVariable, inputs.env, materials) ??
        savedApiKey(builtIn.name, inputs.credentials, materials) ??
        apiKeyFromEnv(builtIn.name, auth.ambientVariable, inputs.env, materials) ?? {
          kind: "missing",
          expected: `${auth.scopedVariable}, ${auth.ambientVariable}, or keywork connect`,
        }
      );
    case "oauth":
      return (
        oauthCredential(builtIn.name, inputs, materials) ?? {
          kind: "missing",
          expected: auth.signInHint,
        }
      );
    case "aws-sigv4": {
      const credentials = credentialsFromEnv(inputs.env);
      if (credentials === undefined || bedrockRegion(inputs) === "") {
        return {
          kind: "missing",
          expected:
            "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION (or bedrockRegion in keywork.json)",
        };
      }
      return present(
        `${builtIn.name}:aws`,
        "AWS environment",
        { kind: "aws-sigv4", credentials },
        materials,
      );
    }
  }
}

function connectionRegistration(
  name: string,
  connection: ConnectionConfig,
  inputs: InferenceInputs,
  materials: Map<string, CredentialMaterial>,
): ProviderRegistration {
  const source =
    connection.credential ?? (isLoopbackEndpoint(connection.endpoint) ? "none" : "saved");
  return {
    name,
    label: name,
    protocol: connection.protocol ?? "chat-completions",
    endpoint: connection.endpoint,
    credential: connectionCredential(name, source, inputs, materials),
    models: mergedModels(connection.models ?? [], reportedModels(name, inputs.observations)),
    openCatalog: true,
    enabled: connection.enabled ?? true,
    ...(connection.insecureTransport !== undefined && {
      insecureTransport: connection.insecureTransport,
    }),
    capabilityDeclarations: inputs.config.models,
  };
}

function connectionCredential(
  name: string,
  source: string,
  inputs: InferenceInputs,
  materials: Map<string, CredentialMaterial>,
): CredentialState {
  if (source === "none") return { kind: "none" };
  if (source === "saved") {
    return (
      savedApiKey(name, inputs.credentials, materials) ?? {
        kind: "missing",
        expected: `keywork connect ${name}`,
      }
    );
  }
  const variable = source.slice("env:".length);
  return (
    apiKeyFromEnv(name, variable, inputs.env, materials) ?? { kind: "missing", expected: variable }
  );
}

function apiKeyFromEnv(
  provider: string,
  variable: string,
  env: Record<string, string | undefined>,
  materials: Map<string, CredentialMaterial>,
): CredentialState | undefined {
  const key = env[variable];
  if (key === undefined || key === "") return undefined;
  return present(`${provider}:env:${variable}`, variable, { kind: "api-key", key }, materials);
}

function savedApiKey(
  provider: string,
  credentials: CredentialMap,
  materials: Map<string, CredentialMaterial>,
): CredentialState | undefined {
  const saved = credentials[provider];
  if (saved?.type !== "api_key" || saved.key === "") return undefined;
  return present(`${provider}:saved`, "saved key", { kind: "api-key", key: saved.key }, materials);
}

function oauthCredential(
  provider: string,
  inputs: InferenceInputs,
  materials: Map<string, CredentialMaterial>,
): CredentialState | undefined {
  const saved = inputs.credentials[provider];
  if (saved?.type !== "oauth") return undefined;
  return present(
    `${provider}:oauth`,
    "ChatGPT sign-in",
    { kind: "bearer", headers: refreshingAuthHeaders(saved, inputs) },
    materials,
  );
}

function refreshingAuthHeaders(
  initial: OauthCredential,
  inputs: InferenceInputs,
): () => Promise<Record<string, string>> {
  let current = initial;
  let pending: Promise<OauthCredential> | undefined;
  const persist = async (refreshed: OauthCredential): Promise<void> => {
    await inputs.persistCredential?.(codexProviderName, refreshed);
  };
  const io = inputs.fetchFn === undefined ? {} : { fetchFn: inputs.fetchFn };
  const currentOrRefreshed = (): Promise<OauthCredential> => {
    pending ??= freshAccessToken(current, persist, io)
      .then((credential) => {
        current = credential;
        return credential;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  return async () => codexAuthHeaders(await currentOrRefreshed());
}

function present(
  id: string,
  label: string,
  material: CredentialMaterial,
  materials: Map<string, CredentialMaterial>,
): CredentialState {
  const handle: CredentialHandle = { id, label };
  materials.set(id, material);
  return { kind: "present", handle };
}

function bedrockRegion(inputs: InferenceInputs): string {
  return regionFromEnv(inputs.env) ?? inputs.config.bedrockRegion ?? "";
}

function reportedModels(name: string, observations: ObservationMap | undefined): ModelSpec[] {
  return (observations?.[name]?.models ?? []).map((id) => ({ id, origin: "reported" as const }));
}

function mergedModels(declared: readonly string[], reported: readonly ModelSpec[]): ModelSpec[] {
  const declaredSpecs = declared.map((id) => ({ id, origin: "declared" as const }));
  const known = new Set(declared);
  return [...declaredSpecs, ...reported.filter((spec) => !known.has(spec.id))];
}
