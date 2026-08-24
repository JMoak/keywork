import type { Protocol, RequestDecorations } from "@keywork/engine";

export type BuiltInAuth =
  | {
      kind: "api-key";
      scopedVariable: string;
      ambientVariable: string;
      keyUrl: string;
      keyPrefix: string;
    }
  | { kind: "oauth"; signInHint: string }
  | { kind: "aws-sigv4" };

export interface BuiltInProvider {
  name: string;
  label: string;
  protocol: Protocol;
  endpoint: string;
  defaultModel: string;
  auth: BuiltInAuth;
  decorations?: RequestDecorations;
}

export const codexProviderName = "openai-codex";

export const builtInProviders: readonly BuiltInProvider[] = [
  {
    name: "openrouter",
    label: "OpenRouter",
    protocol: "chat-completions",
    endpoint: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5-mini",
    auth: {
      kind: "api-key",
      scopedVariable: "KEYWORK_OPENROUTER_API_KEY",
      ambientVariable: "OPENROUTER_API_KEY",
      keyUrl: "https://openrouter.ai/keys",
      keyPrefix: "sk-or-",
    },
    decorations: { body: { usage: { include: true } } },
  },
  {
    name: "openai",
    label: "OpenAI",
    protocol: "chat-completions",
    endpoint: "https://api.openai.com/v1",
    defaultModel: "gpt-5-mini",
    auth: {
      kind: "api-key",
      scopedVariable: "KEYWORK_OPENAI_API_KEY",
      ambientVariable: "OPENAI_API_KEY",
      keyUrl: "https://platform.openai.com/api-keys",
      keyPrefix: "sk-",
    },
  },
  {
    name: codexProviderName,
    label: "OpenAI via ChatGPT Plus/Pro",
    protocol: "responses",
    endpoint: "https://chatgpt.com/backend-api/codex",
    defaultModel: "gpt-5.5",
    auth: { kind: "oauth", signInHint: "keywork connect (ChatGPT sign-in, terminal only)" },
  },
  {
    name: "bedrock",
    label: "Amazon Bedrock",
    protocol: "bedrock-converse",
    endpoint: "",
    defaultModel: "amazon.nova-lite-v1:0",
    auth: { kind: "aws-sigv4" },
  },
];

export const builtInNames: ReadonlySet<string> = new Set(
  builtInProviders.map((provider) => provider.name),
);

export function builtInProvider(name: string): BuiltInProvider | undefined {
  return builtInProviders.find((provider) => provider.name === name);
}

export interface LocalTemplate {
  name: string;
  label: string;
  endpoint: string;
}

export const localTemplates: readonly LocalTemplate[] = [
  { name: "ollama", label: "Ollama", endpoint: "http://localhost:11434/v1" },
  { name: "lmstudio", label: "LM Studio", endpoint: "http://localhost:1234/v1" },
  { name: "llamacpp", label: "llama.cpp server", endpoint: "http://localhost:8080/v1" },
  { name: "vllm", label: "vLLM", endpoint: "http://localhost:8000/v1" },
];
