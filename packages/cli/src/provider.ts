import {
  BedrockProvider,
  credentialsFromEnv,
  OpenAiCompatibleProvider,
  type Provider,
  RetryingProvider,
  regionFromEnv,
} from "@keywork/engine";

export interface ResolvedProvider {
  provider: Provider;
  label: string;
  modelId: string;
}

const catalog = [
  {
    name: "openrouter",
    keyVariables: ["KEYWORK_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5-mini",
  },
  {
    name: "openai",
    keyVariables: ["KEYWORK_OPENAI_API_KEY", "OPENAI_API_KEY"],
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5-mini",
  },
] as const;

export const providerSetupHint = `No provider configured. Easiest fix:
  keywork setup            (interactive, saves the key for you)
Or set an environment variable:
  KEYWORK_OPENROUTER_API_KEY or OPENROUTER_API_KEY  (any model on OpenRouter)
  KEYWORK_OPENAI_API_KEY or OPENAI_API_KEY          (OpenAI directly)
  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION  (Amazon Bedrock)
want a specific model? pass --model or set "model" in keywork.json.`;

export function resolveProvider(
  env: Record<string, string | undefined>,
  model?: string,
  savedKeys?: Record<string, string>,
  bedrockRegion?: string,
): ResolvedProvider | undefined {
  for (const entry of catalog) {
    const apiKey = firstPresent(env, entry.keyVariables) ?? savedKeys?.[entry.name];
    if (apiKey === undefined || apiKey === "") continue;
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
  return resolveBedrock(env, model, bedrockRegion);
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

function firstPresent(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  return names.map((name) => env[name]).find((value) => value !== undefined && value !== "");
}
