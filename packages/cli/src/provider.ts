import {
  BedrockProvider,
  credentialsFromEnv,
  declaredCapabilitiesFor,
  type ModelCapabilityDeclaration,
  OpenAiCompatibleProvider,
  OpenAiResponsesProvider,
  type Provider,
  RetryingProvider,
  regionFromEnv,
  withDeclaredCapabilities,
} from "@keywork/engine";
import type { Credential, CredentialMap, OauthCredential } from "./auth-store.ts";
import { codexAuthHeaders, freshAccessToken } from "./codex-login.ts";

export interface ResolvedProvider {
  provider: Provider;
  label: string;
  modelId: string;
}

export type PersistCredential = (provider: string, credential: Credential) => Promise<void>;

const catalog = [
  {
    name: "openrouter",
    scopedKeyVariable: "KEYWORK_OPENROUTER_API_KEY",
    ambientKeyVariable: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5-mini",
  },
  {
    name: "openai",
    scopedKeyVariable: "KEYWORK_OPENAI_API_KEY",
    ambientKeyVariable: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5-mini",
  },
] as const;

export const codexProviderName = "openai-codex";
const codexResponsesUrl = "https://chatgpt.com/backend-api/codex/responses";
const codexDefaultModel = "gpt-5.5";

export const providerSetupHint = `No provider configured. Easiest fix:
  keywork setup            (interactive: API key or ChatGPT Plus/Pro sign-in)
Or set an environment variable:
  KEYWORK_OPENROUTER_API_KEY or OPENROUTER_API_KEY  (any model on OpenRouter)
  KEYWORK_OPENAI_API_KEY or OPENAI_API_KEY          (OpenAI directly)
  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION  (Amazon Bedrock)
want a specific model? pass --model or set "model" in keywork.json.`;

// Deliberate credentials (a KEYWORK_-scoped variable or anything saved by
// keywork setup) outrank ambient environment variables, so a stale key in a
// shell profile can never hijack a provider the user just connected.
export function resolveProvider(
  env: Record<string, string | undefined>,
  model?: string,
  credentials?: CredentialMap,
  bedrockRegion?: string,
  persistCredential?: PersistCredential,
  declaredModels?: Readonly<Record<string, ModelCapabilityDeclaration>>,
): ResolvedProvider | undefined {
  const resolved =
    firstKeyProvider(model, (entry) => deliberateKey(env, entry, credentials)) ??
    resolveCodex(model, credentials, persistCredential) ??
    firstKeyProvider(model, (entry) => presentValue(env[entry.ambientKeyVariable])) ??
    resolveBedrock(env, model, bedrockRegion);
  if (resolved === undefined) return undefined;
  return {
    ...resolved,
    provider: withDeclaredCapabilities(
      resolved.provider,
      declaredCapabilitiesFor(declaredModels, resolved.modelId),
    ),
  };
}

type CatalogEntry = (typeof catalog)[number];

function firstKeyProvider(
  model: string | undefined,
  keyFor: (entry: CatalogEntry) => string | undefined,
): ResolvedProvider | undefined {
  for (const entry of catalog) {
    const apiKey = keyFor(entry);
    if (apiKey === undefined) continue;
    const chosenModel = model ?? entry.defaultModel;
    return {
      provider: new RetryingProvider(
        new OpenAiCompatibleProvider({
          name: entry.name,
          baseUrl: entry.baseUrl,
          apiKey,
          model: chosenModel,
        }),
      ),
      label: `${entry.name}/${chosenModel}`,
      modelId: chosenModel,
    };
  }
  return undefined;
}

function deliberateKey(
  env: Record<string, string | undefined>,
  entry: CatalogEntry,
  credentials: CredentialMap | undefined,
): string | undefined {
  const scoped = presentValue(env[entry.scopedKeyVariable]);
  if (scoped !== undefined) return scoped;
  const saved = credentials?.[entry.name];
  return saved?.type === "api_key" && saved.key !== "" ? saved.key : undefined;
}

function resolveCodex(
  model: string | undefined,
  credentials: CredentialMap | undefined,
  persistCredential: PersistCredential | undefined,
): ResolvedProvider | undefined {
  const saved = credentials?.[codexProviderName];
  if (saved?.type !== "oauth") return undefined;
  const chosenModel = model ?? codexDefaultModel;
  return {
    provider: new RetryingProvider(
      new OpenAiResponsesProvider({
        name: codexProviderName,
        url: codexResponsesUrl,
        model: chosenModel,
        authHeaders: refreshingAuthHeaders(saved, persistCredential),
      }),
    ),
    label: `${codexProviderName}/${chosenModel}`,
    modelId: chosenModel,
  };
}

function refreshingAuthHeaders(
  initial: OauthCredential,
  persistCredential: PersistCredential | undefined,
): () => Promise<Record<string, string>> {
  let current = initial;
  return async () => {
    current = await freshAccessToken(current, async (refreshed) => {
      await persistCredential?.(codexProviderName, refreshed);
    });
    return codexAuthHeaders(current);
  };
}

const bedrockDefaultModel = "amazon.nova-lite-v1:0";

function resolveBedrock(
  env: Record<string, string | undefined>,
  model?: string,
  configRegion?: string,
): ResolvedProvider | undefined {
  const credentials = credentialsFromEnv(env);
  const region = regionFromEnv(env) ?? configRegion;
  if (credentials === undefined || region === undefined) return undefined;
  const chosenModel = model ?? bedrockDefaultModel;
  return {
    provider: new RetryingProvider(
      new BedrockProvider({ region, model: chosenModel, credentials }),
    ),
    label: `bedrock/${chosenModel}`,
    modelId: chosenModel,
  };
}

function presentValue(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}
