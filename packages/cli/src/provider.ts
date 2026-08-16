import {
  BedrockProvider,
  credentialsFromEnv,
  OpenAiCompatibleProvider,
  OpenAiResponsesProvider,
  type Provider,
  RetryingProvider,
  regionFromEnv,
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

export function resolveProvider(
  env: Record<string, string | undefined>,
  model?: string,
  credentials?: CredentialMap,
  bedrockRegion?: string,
  persistCredential?: PersistCredential,
): ResolvedProvider | undefined {
  for (const entry of catalog) {
    const apiKey = resolveApiKey(env, entry, credentials);
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
  return (
    resolveCodex(model, credentials, persistCredential) ??
    resolveBedrock(env, model, bedrockRegion)
  );
}

// A key saved by keywork setup outranks ambient environment; only the
// KEYWORK_-scoped variable is a deliberate enough signal to override it.
function resolveApiKey(
  env: Record<string, string | undefined>,
  entry: (typeof catalog)[number],
  credentials: CredentialMap | undefined,
): string | undefined {
  const scoped = presentValue(env[entry.scopedKeyVariable]);
  if (scoped !== undefined) return scoped;
  const saved = credentials?.[entry.name];
  if (saved?.type === "api_key" && saved.key !== "") return saved.key;
  return presentValue(env[entry.ambientKeyVariable]);
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
